// Discovers projects that use Claude Code and reads their Claude setup:
// instructions (CLAUDE.md), rules, agents, skills, commands, MCP servers,
// hooks, permissions, memory and sessions. Read-only; secrets are redacted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const HOME = os.homedir();
const ROOT = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const CLAUDE_JSON = process.env.CLAUDE_CONFIG_DIR ? path.join(ROOT, '.claude.json') : path.join(HOME, '.claude.json');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const MAX_TEXT = 256 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'build', 'dist', '.dart_tool', '.venv', 'venv', '__pycache__', '.next', 'target', 'vendor', '.idea', '.vs', 'coverage']);

export const slug = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const norm = (p) => {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};
const readdir = (d, opts) => { try { return fs.readdirSync(d, opts); } catch { return []; } };
const statOf = (f) => { try { return fs.statSync(f); } catch { return null; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function readText(f) {
  const st = statOf(f);
  if (!st?.isFile()) return null;
  if (st.size <= MAX_TEXT) return fs.readFileSync(f, 'utf8');
  const buf = Buffer.alloc(MAX_TEXT);
  const fd = fs.openSync(f, 'r');
  try { fs.readSync(fd, buf, 0, MAX_TEXT, 0); } finally { fs.closeSync(fd); }
  return buf.toString('utf8') + '\n\n… (truncated)';
}

/* ---------- redaction ---------- */

const SECRET_RE = /(sk-[A-Za-z0-9_-]{8,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,})/g;
const KV_SECRET_RE = /((?:api[_-]?key|token|secret|password|passwd)["']?\s*[=:]\s*["']?)[^\s"'&]+/gi;
const URL_CRED_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi;     // scheme://user:pass@
const ENV_FLAG_RE = /((?:^|\s)(?:-e|--env)\s+[A-Za-z_][A-Za-z0-9_]*=)\S+/g; // docker -e NAME=value
const SECRET_FLAG_RE = /((?:^|\s)--?(?:api[_-]?key|(?:access[_-]?|auth[_-]?)?token|secret|password|passwd)\s+)(?!-)\S+/gi; // --api-key value
export const redact = (s) => String(s ?? '')
  .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 •••')
  .replace(URL_CRED_RE, '$1•••@')
  .replace(ENV_FLAG_RE, '$1•••')
  .replace(SECRET_FLAG_RE, '$1•••')
  .replace(SECRET_RE, '•••')
  .replace(KV_SECRET_RE, '$1•••');
function redactUrl(u) {
  try {
    const x = new URL(u);
    x.username = ''; x.password = '';
    if (x.search) x.search = '?•••';
    return x.toString();
  } catch { return redact(u); }
}

/* ---------- frontmatter ---------- */

const unquote = (v) => {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
};

export function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text || '');
  if (!m) return { meta: {}, body: text || '' };
  const meta = {};
  let key = null; let mode = null; let style = '>'; let buf = []; let obj = {};
  const flush = () => {
    if (!key) return;
    if (mode === 'list') meta[key] = buf;
    else if (mode === 'map') meta[key] = obj;
    else if (mode === 'block') meta[key] = style === '|' ? buf.join('\n') : buf.join(' ').trim();
    else meta[key] = '';
    key = null; mode = null; buf = []; obj = {};
  };
  for (const line of m[1].split(/\r?\n/)) {
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top) {
      flush();
      const [, k, v] = top;
      if (v === '') { key = k; mode = 'open'; } else if (/^[>|][-+]?$/.test(v)) { key = k; mode = 'block'; style = v[0]; } else meta[k] = unquote(v);
      continue;
    }
    if (!key || !line.trim()) continue;
    const li = /^\s*-\s+(.*)$/.exec(line);
    const sub = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (mode !== 'block' && li) { mode = 'list'; buf.push(unquote(li[1])); } else if ((mode === 'open' || mode === 'map') && sub) { mode = 'map'; obj[sub[1]] = unquote(sub[2]); } else { mode = 'block'; buf.push(line.trim()); }
  }
  flush();
  return { meta, body: text.slice(m[0].length) };
}

const asList = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean) : []);

/* ---------- file walkers ---------- */

function walk(dir, { depth = 4, match, limit = 500, skip = SKIP_DIRS } = {}) {
  const out = [];
  let visited = 0;
  const go = (d, lvl) => {
    if (out.length >= limit || visited++ > 4000) return;
    for (const e of readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (lvl < depth && !skip.has(e.name)) go(full, lvl + 1); } else if (match(e.name, full)) out.push(full);
    }
  };
  go(dir, 0);
  return out;
}

function docItem(file, root, extra = {}) {
  const text = readText(file) ?? '';
  const { meta, body } = parseFrontmatter(text);
  const st = statOf(file);
  return {
    file,
    rel: path.relative(root, file).replace(/\\/g, '/'),
    name: meta.name || path.basename(file, '.md'),
    description: typeof meta.description === 'string' ? meta.description : '',
    meta,
    body: body.trim(),
    size: st?.size || 0,
    mtime: st?.mtimeMs || 0,
    ...extra,
  };
}

function agentsIn(base, source) {
  return walk(path.join(base, 'agents'), { depth: 2, match: (n) => n.endsWith('.md') }).map((f) => {
    const d = docItem(f, base, { source });
    d.model = d.meta.model || '';
    d.tools = asList(d.meta.tools);
    d.color = d.meta.color || '';
    return d;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function skillsIn(base, source) {
  return walk(path.join(base, 'skills'), { depth: 4, match: (n) => n === 'SKILL.md' }).map((f) => {
    const dir = path.dirname(f);
    const d = docItem(f, base, { source });
    d.name = d.meta.name || path.basename(dir);
    if (d.rel.startsWith('skills/synced/')) d.source = 'claude.ai';
    d.files = walk(dir, { depth: 3, match: (n) => n !== 'SKILL.md', limit: 50 }).map((x) => path.relative(dir, x).replace(/\\/g, '/'));
    return d;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function commandsIn(base, source) {
  const root = path.join(base, 'commands');
  return walk(root, { depth: 4, match: (n) => n.endsWith('.md') }).map((f) => {
    const d = docItem(f, base, { source });
    d.name = '/' + path.relative(root, f).replace(/\\/g, '/').replace(/\.md$/, '').replace(/\//g, ':');
    d.argumentHint = d.meta['argument-hint'] || '';
    return d;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function rulesIn(base, source) {
  return walk(path.join(base, 'rules'), { depth: 4, match: (n) => n.endsWith('.md') }).map((f) => {
    const d = docItem(f, base, { source });
    d.name = path.relative(path.join(base, 'rules'), f).replace(/\\/g, '/');
    d.paths = asList(d.meta.paths || d.meta.globs);
    return d;
  });
}

function memoryIn(dir) {
  return readdir(dir).filter((n) => n.endsWith('.md')).map((n) => {
    const d = docItem(path.join(dir, n), dir);
    d.type = d.meta.metadata?.type || d.meta.type || (n === 'MEMORY.md' ? 'index' : '');
    return d;
  }).sort((a, b) => (a.type === 'index' ? -1 : b.type === 'index' ? 1 : a.name.localeCompare(b.name)));
}

/* ---------- settings / MCP ---------- */

function settingsFile(file, label) {
  const j = readJson(file);
  if (!j) return null;
  const hooks = [];
  for (const [event, groups] of Object.entries(j.hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of g.hooks || []) {
        hooks.push({
          event, matcher: g.matcher || '*', type: h.type || 'command',
          command: redact([h.command, ...(h.args || [])].filter(Boolean).join(' ') || h.prompt || h.url || ''),
          timeout: h.timeout ?? null, source: label,
        });
      }
    }
  }
  const p = j.permissions || {};
  return {
    file, label,
    hooks,
    permissions: {
      allow: p.allow || [], deny: p.deny || [], ask: p.ask || [],
      additionalDirectories: p.additionalDirectories || [], defaultMode: p.defaultMode || '',
    },
    env: Object.keys(j.env || {}),
    model: j.model || '',
    enabledPlugins: Object.entries(j.enabledPlugins || {}).filter(([, v]) => v).map(([k]) => k),
    other: Object.keys(j).filter((k) => !['hooks', 'permissions', 'env', 'model', 'enabledPlugins'].includes(k)),
  };
}

function mcpServers(obj, scope, source) {
  return Object.entries(obj || {}).map(([name, s]) => ({
    name, scope, source,
    type: s.type || (s.url ? 'http' : 'stdio'),
    target: s.url ? redactUrl(s.url) : redact([s.command, ...(s.args || [])].filter(Boolean).join(' ')),
    env: Object.keys(s.env || {}),
    headers: Object.keys(s.headers || {}),
  }));
}

/* ---------- usage stats from transcripts ---------- */

const usageCache = new Map(); // file -> { key, counts }

const MAX_USAGE_SCAN = 256 * 1024 * 1024;

// Caches the scan's promise, so concurrent requests share one pass over each file.
function usageOf(file) {
  const st = statOf(file);
  if (!st || st.size > MAX_USAGE_SCAN) return null;
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = usageCache.get(file);
  if (hit?.key === key) return hit.counts;
  const counts = scanUsage(file);
  usageCache.set(file, { key, counts });
  return counts;
}

// Streams line by line so large transcripts neither load into memory nor block the event loop.
async function scanUsage(file) {
  const counts = { agents: {}, skills: {}, commands: {} };
  const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
  try {
    const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) {
      for (const m of line.matchAll(/"subagent_type":"([^"]+)"/g)) bump(counts.agents, m[1]);
      for (const m of line.matchAll(/"name":"Skill","input":\{[^}]*?"skill":"([^"]+)"/g)) bump(counts.skills, m[1]);
      for (const m of line.matchAll(/<command-name>\/?([^<]+)<\/command-name>/g)) bump(counts.commands, '/' + m[1].trim());
    }
  } catch { return null; } // vanished or unreadable
  return counts;
}

function transcriptsOf(id) {
  const dir = path.join(PROJECTS_DIR, id);
  const main = readdir(dir).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n));
  const subs = readdir(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
    .flatMap((e) => readdir(path.join(dir, e.name, 'subagents')).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, e.name, 'subagents', n)));
  return { main, subs };
}

async function usageFor(id) {
  const total = { agents: {}, skills: {}, commands: {} };
  const { main, subs } = transcriptsOf(id);
  for (const f of [...main, ...subs]) {
    const c = await usageOf(f);
    if (!c) continue;
    for (const k of Object.keys(total)) for (const [n, v] of Object.entries(c[k])) total[k][n] = (total[k][n] || 0) + v;
  }
  return total;
}

const titleCache = new Map();
function sessionInfo(file) {
  const st = statOf(file);
  if (!st) return null;
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = titleCache.get(file);
  if (hit?.key === key) return hit.info;
  const len = Math.min(st.size, 512 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
  const text = buf.toString('utf8');
  const pick = (re) => { let v = ''; for (const m of text.matchAll(re)) v = m[1]; return v ? JSON.parse(`"${v}"`) : ''; };
  const info = {
    id: path.basename(file, '.jsonl'),
    title: pick(/"aiTitle":"((?:[^"\\]|\\.)*)"/g) || pick(/"agentName":"((?:[^"\\]|\\.)*)"/g),
    lastPrompt: pick(/"lastPrompt":"((?:[^"\\]|\\.)*)"/g).slice(0, 200),
    branch: pick(/"gitBranch":"((?:[^"\\]|\\.)*)"/g),
    size: st.size,
    mtime: st.mtimeMs,
  };
  titleCache.set(file, { key, info });
  return info;
}

/* ---------- project discovery ---------- */

function cwdFromTranscripts(id) {
  for (const n of readdir(path.join(PROJECTS_DIR, id))) {
    if (!n.endsWith('.jsonl')) continue;
    const f = path.join(PROJECTS_DIR, id, n);
    const len = Math.min(statOf(f)?.size || 0, 128 * 1024);
    if (!len) continue;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r');
    try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8'));
    if (m) return JSON.parse(`"${m[1]}"`);
  }
  return null;
}

const cwdCache = new Map();

export class ProjectCatalog {
  constructor(collector) { this.collector = collector; }

  claudeJson() { return readJson(CLAUDE_JSON) || {}; }

  // id (the ~/.claude/projects folder name) -> { id, path, cfg }
  discover() {
    const cj = this.claudeJson();
    const map = new Map();
    for (const [p, cfg] of Object.entries(cj.projects || {})) {
      const id = slug(p.replace(/\//g, path.sep));
      map.set(id, { id, path: path.normalize(p), cfg });
    }
    for (const id of readdir(PROJECTS_DIR)) {
      if (map.has(id) || !statOf(path.join(PROJECTS_DIR, id))?.isDirectory()) continue;
      if (!cwdCache.has(id)) cwdCache.set(id, cwdFromTranscripts(id));
      const p = cwdCache.get(id);
      if (p) map.set(id, { id, path: p, cfg: {} });
    }
    return { cj, map };
  }

  liveFor(projectPath) {
    const n = norm(projectPath);
    return this.collector.snapshot().filter((a) => a.live && norm(a.cwd) === n)
      .map((a) => ({ key: a.key, name: a.name, status: a.status, now: a.now }));
  }

  config(projectPath, cfg, cj) {
    const base = path.join(projectPath, '.claude');
    const instructions = [];
    const seen = new Set();
    const addDoc = (f) => { if (!seen.has(f) && statOf(f)?.isFile()) { seen.add(f); instructions.push(docItem(f, projectPath)); } };
    addDoc(path.join(projectPath, 'CLAUDE.md'));
    addDoc(path.join(projectPath, 'CLAUDE.local.md'));
    addDoc(path.join(base, 'CLAUDE.md'));
    for (const f of walk(projectPath, { depth: 3, match: (n) => n === 'CLAUDE.md' || n === 'CLAUDE.local.md', limit: 30, skip: new Set([...SKIP_DIRS, '.claude']) })) addDoc(f);

    const settings = [
      settingsFile(path.join(base, 'settings.json'), '.claude/settings.json'),
      settingsFile(path.join(base, 'settings.local.json'), '.claude/settings.local.json'),
    ].filter(Boolean);

    const mcpJson = readJson(path.join(projectPath, '.mcp.json'));
    const mcp = [
      ...mcpServers(mcpJson?.mcpServers, 'project', '.mcp.json'),
      ...mcpServers(cfg.mcpServers, 'local', '~/.claude.json'),
    ];
    for (const s of mcp) {
      if (s.scope !== 'project') continue;
      if ((cfg.disabledMcpjsonServers || []).includes(s.name)) s.state = 'disabled';
      else if ((cfg.enabledMcpjsonServers || []).includes(s.name)) s.state = 'enabled';
    }

    return {
      instructions,
      rules: rulesIn(base, 'project'),
      agents: agentsIn(base, 'project'),
      skills: skillsIn(base, 'project'),
      commands: commandsIn(base, 'project'),
      mcp,
      settings,
      hooks: settings.flatMap((s) => s.hooks),
      allowedTools: cfg.allowedTools || [],
      memory: memoryIn(path.join(PROJECTS_DIR, slug(projectPath), 'memory')),
    };
  }

  userConfig(cj) {
    const settings = [
      settingsFile(path.join(ROOT, 'settings.json'), '~/.claude/settings.json'),
      settingsFile(path.join(ROOT, 'settings.local.json'), '~/.claude/settings.local.json'),
    ].filter(Boolean);
    const enabled = new Set(settings.flatMap((s) => s.enabledPlugins));
    const installed = readJson(path.join(ROOT, 'plugins', 'installed_plugins.json'))?.plugins || {};
    const plugins = Object.entries(installed).map(([id, entries]) => {
      const e = (Array.isArray(entries) ? entries : [entries])[0] || {};
      const dir = e.installPath || '';
      return {
        id, name: id.split('@')[0], marketplace: id.split('@')[1] || '', version: e.version || '', scope: e.scope || '',
        enabled: enabled.has(id),
        agents: dir ? agentsIn(dir, id).map((a) => a.name) : [],
        skills: dir ? skillsIn(dir, id).map((s) => s.name) : [],
        commands: dir ? commandsIn(dir, id).map((c) => c.name) : [],
        hooks: dir && statOf(path.join(dir, 'hooks', 'hooks.json')) ? Object.keys(readJson(path.join(dir, 'hooks', 'hooks.json'))?.hooks || {}) : [],
        mcp: dir ? Object.keys(readJson(path.join(dir, '.mcp.json'))?.mcpServers || readJson(path.join(dir, '.mcp.json')) || {}) : [],
      };
    }).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));

    const instructions = [];
    const f = path.join(ROOT, 'CLAUDE.md');
    if (statOf(f)?.isFile()) instructions.push(docItem(f, ROOT));

    return {
      instructions,
      rules: rulesIn(ROOT, 'user'),
      agents: agentsIn(ROOT, 'user'),
      skills: skillsIn(ROOT, 'user'),
      commands: commandsIn(ROOT, 'user'),
      mcp: mcpServers(cj.mcpServers, 'user', '~/.claude.json'),
      settings,
      hooks: settings.flatMap((s) => s.hooks),
      allowedTools: [],
      memory: [],
      plugins,
    };
  }

  counts(c) {
    return {
      instructions: c.instructions.length, rules: c.rules.length, agents: c.agents.length, skills: c.skills.length,
      commands: c.commands.length, mcp: c.mcp.length, hooks: c.hooks.length, memory: c.memory.length,
      plugins: c.plugins?.filter((p) => p.enabled).length,
    };
  }

  sessionsOf(id) {
    return transcriptsOf(id).main.map(sessionInfo).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  }

  list() {
    const { cj, map } = this.discover();
    const projects = [...map.values()].map(({ id, path: p, cfg }) => {
      const exists = !!statOf(p)?.isDirectory();
      const files = transcriptsOf(id).main;
      const lastActive = Math.max(0, ...files.map((f) => statOf(f)?.mtimeMs || 0));
      const c = exists ? this.config(p, cfg, cj) : null;
      return {
        id, path: p, name: path.basename(p) || p, exists,
        sessions: files.length, lastActive,
        live: this.liveFor(p),
        counts: c ? this.counts(c) : null,
        stats: { lastCost: cfg.lastCost ?? null, linesAdded: cfg.lastLinesAdded ?? null, linesRemoved: cfg.lastLinesRemoved ?? null },
      };
    }).sort((a, b) => (b.live.length - a.live.length) || (b.lastActive - a.lastActive));
    const u = this.userConfig(cj);
    return { user: { id: 'user', name: 'Your global setup', path: ROOT, counts: this.counts(u) }, projects };
  }

  async detail(id) {
    const { cj, map } = this.discover();
    if (id === 'user') {
      const c = this.userConfig(cj);
      return { id, name: 'Your global setup', path: ROOT, exists: true, isUser: true, counts: this.counts(c), config: c, sessions: [], live: [], usage: null };
    }
    const entry = map.get(id);
    if (!entry) return null; // only known projects can be read
    const exists = !!statOf(entry.path)?.isDirectory();
    const config = exists ? this.config(entry.path, entry.cfg, cj) : null;
    const u = this.userConfig(cj);
    const cfg = entry.cfg;
    return {
      id, name: path.basename(entry.path), path: entry.path, exists,
      counts: config ? this.counts(config) : null,
      config,
      inherited: { agents: u.agents.length, skills: u.skills.length, commands: u.commands.length, mcp: u.mcp.length, hooks: u.hooks.length, plugins: u.plugins.filter((p) => p.enabled).length },
      sessions: this.sessionsOf(id),
      live: this.liveFor(entry.path),
      usage: await usageFor(id),
      stats: {
        lastCost: cfg.lastCost ?? null, lastDuration: cfg.lastDuration ?? null,
        linesAdded: cfg.lastLinesAdded ?? null, linesRemoved: cfg.lastLinesRemoved ?? null,
        inputTokens: cfg.lastTotalInputTokens ?? null, outputTokens: cfg.lastTotalOutputTokens ?? null,
        models: Object.keys(cfg.lastModelUsage || {}),
      },
    };
  }
}
