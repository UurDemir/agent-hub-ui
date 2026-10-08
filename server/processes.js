// Detects other AI agents / AI editors on this PC by scanning the process list.
// These don't expose a transcript we can read, so we show presence and footprint.
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { redact } from './projects.js';

const AGENTS = [
  { id: 'cursor', label: 'Cursor', match: (p) => p.name === 'cursor.exe' || p.name === 'cursor' },
  { id: 'windsurf', label: 'Windsurf', match: (p) => /^windsurf(\.exe)?$/.test(p.name) },
  { id: 'copilot-cli', label: 'GitHub Copilot CLI', match: (p) => p.name === 'copilot.exe' || /@github[\\/]copilot[\\/]/i.test(p.cmd) },
  { id: 'codex', label: 'OpenAI Codex CLI', match: (p) => /^codex(\.exe)?$/.test(p.name) || /@openai[\\/]codex[\\/]/i.test(p.cmd) },
  { id: 'gemini', label: 'Gemini CLI', match: (p) => /^gemini(\.exe)?$/.test(p.name) || /@google[\\/]gemini-cli[\\/]/i.test(p.cmd) },
  { id: 'aider', label: 'Aider', match: (p) => p.bins.includes('aider') },
  { id: 'opencode', label: 'opencode', match: (p) => /^opencode(\.exe)?$/.test(p.name) || /opencode-ai[\\/]/i.test(p.cmd) },
  { id: 'goose', label: 'Goose', match: (p) => /^goose(\.exe)?$/.test(p.name) },
  { id: 'claude-desktop', label: 'Claude Desktop', match: (p) => p.name === 'claude.exe' && /AnthropicClaude|[\\/]Claude[\\/]app-/i.test(p.exe) },
  { id: 'ollama', label: 'Ollama (local models)', match: (p) => /^ollama( app)?(\.exe)?$/.test(p.name) },
  { id: 'lmstudio', label: 'LM Studio', match: (p) => /^lm studio(\.exe)?$/.test(p.name) },
];

const PS_SCRIPT = `
Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; exe = $_.ExecutablePath
    cmd = $_.CommandLine; mem = $_.WorkingSetSize
    start = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  }
} | ConvertTo-Json -Compress`;

const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 128 * 1024 * 1024, windowsHide: true, timeout: 30000 }, (err, stdout) =>
    (err ? reject(err) : resolve(stdout)));
});

async function listProcesses() {
  if (process.platform === 'win32') {
    const enc = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc]);
    const rows = JSON.parse(out || '[]');
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      pid: r.pid, ppid: r.ppid, name: String(r.name || '').toLowerCase(), exe: r.exe || '', cmd: r.cmd || '',
      mem: Number(r.mem) || 0, start: r.start ? Date.parse(r.start) : null,
    }));
  }
  const out = await run('ps', ['-axo', 'pid=,ppid=,rss=,args=']);
  return out.split('\n').filter(Boolean).map((line) => {
    const [, pid, ppid, rss, cmd] = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/) || [];
    const exe = (cmd || '').split(/\s+/)[0] || '';
    return { pid: +pid, ppid: +ppid, name: path.basename(exe).toLowerCase(), exe, cmd: cmd || '', mem: +rss * 1024, start: null };
  });
}

// Basenames of every token in the command line, without extensions: "python -m aider" -> [python, -m, aider]
const binsOf = (cmd) => (cmd.match(/"[^"]*"|\S+/g) || [])
  .map((t) => t.replace(/"/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|js|mjs|cjs|ps1|py)$/, ''));

export class ProcessScanner extends EventEmitter {
  others = [];

  start(intervalMs = 10000) {
    const loop = async () => {
      try {
        this.others = this.group(await listProcesses());
        this.emit('update', this.others);
      } catch (e) {
        console.error('[processes] scan failed:', e.message);
      }
      setTimeout(loop, intervalMs);
    };
    loop();
  }

  group(procs) {
    const groups = new Map();
    for (const p of procs) {
      if (p.pid === process.pid) continue;
      p.bins = binsOf(p.cmd);
      const a = AGENTS.find((x) => x.match(p));
      if (!a) continue;
      const g = groups.get(a.id) || { id: a.id, label: a.label, pids: [], memory: 0, startedAt: null, cmd: '' };
      g.pids.push(p.pid);
      g.memory += p.mem;
      if (p.start && (!g.startedAt || p.start < g.startedAt)) g.startedAt = p.start;
      if (!g.cmd) g.cmd = redact(p.exe || p.cmd).slice(0, 200);
      groups.set(a.id, g);
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  }
}
