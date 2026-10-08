// Summarizes the *shape* of recent Claude Code transcripts (record types, content block
// types, tool names and input keys, usage keys) so it can be compared with server/parse.js.
// Prints only names and counts, never message content.
//   node .claude/scripts/transcript-survey.mjs [maxFiles=40]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS = path.join(ROOT, 'projects');
const MAX = Number(process.argv[2]) || 40;
const ls = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

const files = [];
for (const p of ls(PROJECTS).filter((e) => e.isDirectory())) {
  const dir = path.join(PROJECTS, p.name);
  for (const e of ls(dir)) {
    if (e.isFile() && e.name.endsWith('.jsonl')) files.push(path.join(dir, e.name));
    if (e.isDirectory()) for (const s of ls(path.join(dir, e.name, 'subagents'))) if (s.name.endsWith('.jsonl')) files.push(path.join(dir, e.name, 'subagents', s.name));
  }
}
const recent = files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, MAX);

const out = { files: recent.length, records: {}, topKeys: {}, assistantBlocks: {}, userBlocks: {}, userTextPrefixes: {}, stopReasons: {}, usageKeys: {}, tools: {}, toolInputKeys: {}, sessionFileKeys: {}, subagentMetaKeys: {} };
const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
const keys = (m, name, obj) => { m[name] ||= {}; for (const k of Object.keys(obj || {})) bump(m[name], k); };

for (const { f } of recent) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const type = j.type === 'system' ? `system/${j.subtype || '?'}` : String(j.type);
    bump(out.records, type);
    keys(out.topKeys, type, j);
    const m = j.message || {};
    if (m.stop_reason) bump(out.stopReasons, m.stop_reason);
    for (const k of Object.keys(m.usage || {})) bump(out.usageKeys, k);
    const content = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'string', text: m.content }] : [];
    for (const c of content) {
      bump(j.type === 'assistant' ? out.assistantBlocks : out.userBlocks, c.type);
      if (c.type === 'tool_use') {
        const name = c.name.startsWith('mcp__') ? 'mcp__*' : c.name;
        bump(out.tools, name);
        if (name !== 'mcp__*') keys(out.toolInputKeys, name, c.input);
      }
      const text = j.type === 'user' && (c.type === 'text' || c.type === 'string') ? String(c.text).trim() : '';
      const prefix = text.match(/^(<[a-z-]+|\[[A-Za-z ]+)/)?.[1];
      if (prefix) bump(out.userTextPrefixes, prefix);
    }
  }
}
for (const e of ls(path.join(ROOT, 'sessions'))) if (e.name.endsWith('.json')) {
  try { keys(out, 'sessionFileKeys', JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', e.name), 'utf8'))); } catch { /* skip */ }
}
for (const { f } of recent) {
  const meta = f.replace(/\.jsonl$/, '.meta.json');
  if (fs.existsSync(meta)) try { keys(out, 'subagentMetaKeys', JSON.parse(fs.readFileSync(meta, 'utf8'))); } catch { /* skip */ }
}
console.log(JSON.stringify(out, null, 1));
