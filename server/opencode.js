// Watches opencode's local sessions. opencode (github.com/anomalyco/opencode, formerly sst/opencode)
// keeps everything in one SQLite database, $XDG_DATA_HOME/opencode/opencode.db (default
// ~/.local/share/opencode, on Windows too; OPENCODE_DB names another file, absolute or relative to
// that folder; non-stable channels use opencode-<channel>.db). Two schemas are read:
// - opencode 2.x: session_v2, session_message (one row per message, `type` + JSON `data`) and
//   session_part (one row per assistant part: text, reasoning, tool). Sources:
//   packages/core/src/session/sql.ts, packages/schema/src/session-message.ts, session/projector.ts.
// - opencode 1.x (1.2 and later): session, message and part, with the message and part JSON of
//   packages/schema/src/v1/session.ts. A 2.x database keeps these tables after migrating them.
// Versions before 1.2 used JSON files under storage/ and are only detected as a process.
// Reading needs node:sqlite (Node 22.13+); on an older Node opencode is only shown as a process.
// Read-only: the database is opened read-only, and with immutable=1 when no opencode has it open,
// so SQLite doesn't create its -wal/-shm files either.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { SECRET_KEY, activity, clip, summaryFields, toolLabel } from './parse.js';

export const OPENCODE_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode');
const RECENT_MS = 3 * 3600e3;    // sessions active this recently are shown
const MAX_RECENT = 10;
const LIVE_IDLE_MS = 30 * 60e3;  // an idle session counts as open this long after its last activity
const BUSY_MS = 30 * 60e3;       // a turn with no activity for this long no longer counts as working
const WAL_FRESH_MS = 120e3;      // a -wal written this recently means an opencode is running
const INITIAL_MESSAGES = 300;
const MAX_OPEN = 20;             // messages per session re-read while they are still being written
const MAX_EVENTS = 400;

const readdir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const statOf = (f) => { try { return fs.statSync(f); } catch { return null; } };
const parseJson = (s) => { if (typeof s !== 'string') return s && typeof s === 'object' ? s : null; try { return JSON.parse(s); } catch { return null; } };
const firstLine = (s) => String(s ?? '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
const base = (p) => (p ? path.basename(String(p)) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// Paths are stored with forward slashes on Windows ("C:/Users/…").
const platformPath = (p) => (process.platform === 'win32' && /^[A-Za-z]:\//.test(p) ? p.replaceAll('/', '\\') : p);

// The database files in opencode's data folder.
export function opencodeDbs(dir) {
  const named = process.env.OPENCODE_DB?.trim();
  if (named === ':memory:') return [];
  if (named) return [path.resolve(dir, named)];
  // opencode-next.db is a one-time import source of pre-release 2.x builds, not a live database.
  return readdir(dir).filter((f) => /^opencode(?:-[\w.-]+)?\.db$/.test(f) && f !== 'opencode-next.db').map((f) => path.join(dir, f));
}

/* ---------- tools ---------- */

// 2.x names first; 1.x names (bash, task, apply_patch, list…) were renamed by the 2.x migration.
const CATEGORY = {
  read: 'read', glob: 'read', grep: 'read', list: 'read', ls: 'read', lsp: 'read',
  opencode_session_search: 'read', opencode_session_read: 'read',
  write: 'edit', edit: 'edit', patch: 'edit', apply_patch: 'edit', multiedit: 'edit',
  shell: 'run', bash: 'run', cd: 'run', execute: 'run', batch: 'run',
  webfetch: 'web', websearch: 'web', codesearch: 'web',
  subagent: 'agent', task: 'agent', opencode_session_interrupt: 'agent',
  todowrite: 'plan', todoread: 'plan', skill: 'plan',
  question: 'ask',
  generate_image: 'other', generate_video: 'other', invalid: 'other',
};
// Built-in tools that live in a namespace (<namespace>_<tool>), so their names have an underscore too.
const BUILTIN_NS = /^(?:opencode|automation|machine)_/;
// MCP tools are <server>_<tool>, both sanitized to [A-Za-z0-9_-]. The split at the first underscore
// is a guess when the server name itself has one.
const mcpName = (name) => {
  if (CATEGORY[name] || BUILTIN_NS.test(name) || name.startsWith('mcp__')) return name;
  const i = name.indexOf('_');
  return i > 0 && i < name.length - 1 ? `mcp__${name.slice(0, i)}__${name.slice(i + 1)}` : name;
};
export const opencodeCategory = (name) => {
  if (CATEGORY[name]) return CATEGORY[name];
  if (name.startsWith('automation_')) return 'plan';
  if (/^opencode_(?:list_mcp|read_mcp)/.test(name)) return 'mcp';
  return mcpName(name).startsWith('mcp__') ? 'mcp' : 'other';
};

// Arguments named like secrets never leave the collector.
const scrub = (v, depth = 0) => {
  if (Array.isArray(v)) return depth > 6 ? [] : v.map((x) => scrub(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  return depth > 6 ? {} : Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_KEY.test(k)).map(([k, x]) => [k, scrub(x, depth + 1)]));
};
const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
const filePath = (a) => a.path ?? a.filePath; // 1.x used filePath
const patchFiles = (patch) => [...String(patch ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
const TODO_STATUS = { pending: 'pending', in_progress: 'in_progress', completed: 'completed', cancelled: 'completed' };
const todoLines = (todos) => (Array.isArray(todos) ? todos : []).map((t) =>
  `[${t?.status === 'completed' ? 'x' : t?.status === 'in_progress' ? '~' : t?.status === 'cancelled' ? '-' : ' '}] ${t?.content ?? ''}`).join('\n');

// A summary written for this tool, or null: summaryFields() then uses its first text argument,
// marked freeText so a hub only gets it at the full level.
function toolSummary(name, a) {
  switch (name) {
    case 'read': case 'write': case 'edit': case 'multiedit': return base(filePath(a));
    case 'list': case 'ls': return base(a.path) || '.';
    case 'cd': return a.path ? base(a.path) : '~';
    case 'grep': return `"${a.pattern ?? ''}"${a.path ? ' in ' + base(a.path) : ''}`;
    case 'glob': return a.pattern;
    case 'shell': case 'bash': return a.description || firstLine(a.command);
    case 'patch': case 'apply_patch': {
      const files = patchFiles(a.patchText);
      return files.length > 2 ? `${base(files[0])} +${files.length - 1} files` : files.map(base).join(', ');
    }
    case 'webfetch': return host(a.url);
    case 'websearch': case 'codesearch': return a.query;
    // The task itself is a prompt (detail only); the description is a short label for it.
    case 'subagent': case 'task': return [a.description, a.agent || a.subagent_type].filter(Boolean).join(' · ') || 'Subagent';
    case 'todowrite': return `${(a.todos || []).length} todos`;
    case 'todoread': return 'Todos';
    case 'skill': return a.id || a.name;
  }
  return null;
}

function toolDetail(name, a) {
  switch (name) {
    case 'shell': case 'bash': return `${a.command ?? ''}${a.workdir ? `\n(in ${a.workdir})` : ''}`;
    case 'edit': return `${filePath(a)}\n- ${clip(a.oldString, 500)}\n+ ${clip(a.newString, 500)}`;
    case 'write': return `${filePath(a)}\n${String(a.content ?? '').split('\n').length} lines`;
    case 'patch': case 'apply_patch': return String(a.patchText ?? '');
    case 'subagent': case 'task': return String(a.prompt ?? '');
    case 'todowrite': return todoLines(a.todos);
  }
  return JSON.stringify(scrub(a), null, 1);
}

const contentText = (content) => (Array.isArray(content) ? content : [])
  .map((c) => (c?.type === 'text' ? String(c.text ?? '') : c?.type === 'file' ? `[${c.name || c.mime || 'file'}]` : '')).filter(Boolean).join('\n');
const usageOf = (tk) => {
  const t = obj(tk);
  const cache = obj(t.cache);
  return { out: num(t.output), context: num(t.input) + num(cache.read) + num(cache.write) };
};
const FINAL = (finish) => !!finish && finish !== 'tool-calls' && finish !== 'unknown';

/* ---------- rows -> normalized messages ---------- */

// Both schemas become { id, role, t, updated, … } with assistant parts as
// { key, kind: 'text' | 'reasoning' | 'tool', … }.

function v2Part(c, key) {
  c = obj(c);
  switch (c.type) {
    case 'text': return { key, kind: 'text', text: String(c.text ?? '') };
    case 'reasoning': return { key, kind: 'reasoning', done: !!c.time?.completed };
    case 'tool': {
      const s = obj(c.state);
      const meta = obj(s.metadata);
      return {
        key, kind: 'tool', id: String(c.id || key), name: String(c.name || 'tool'),
        status: s.status === 'streaming' ? 'pending' : String(s.status || 'pending'),
        input: obj(s.input), // a streaming call's input is still a partial JSON string
        ok: s.status === 'completed' && (meta.exit == null || meta.exit === 0),
        output: s.status === 'error' ? [s.error?.message, contentText(s.content)].filter(Boolean).join('\n') : contentText(s.content),
        start: num(c.time?.ran) || num(c.time?.created), end: num(c.time?.completed),
      };
    }
  }
  return null;
}

export function v2Message(row, partRows = []) {
  const d = obj(parseJson(row.data));
  const head = { id: String(row.id), t: num(d.time?.created) || num(row.time_created), updated: num(row.time_updated) };
  for (const p of partRows) head.updated = Math.max(head.updated, num(p.time_updated));
  switch (row.type) {
    case 'user': return { ...head, role: 'user', text: String(d.text ?? '') };
    case 'assistant': {
      // Parts live in session_part; rows written before that (or with part_rows off) keep them inline.
      const parts = [
        ...partRows.map((p) => v2Part({ ...obj(parseJson(p.data)), type: p.type }, `${row.id}:${p.ordinal}`)),
        ...(Array.isArray(d.content) ? d.content.map((c, i) => v2Part(c, `${row.id}:i${i}`)) : []),
      ].filter(Boolean);
      return {
        ...head, role: 'assistant', done: !!d.time?.completed, finish: d.finish, error: d.error?.message,
        model: d.model?.id, tokens: d.tokens, cost: d.cost, parts,
      };
    }
    case 'shell': // a command the user ran with !
      return { ...head, role: 'shell', command: String(d.command ?? ''), running: d.status === 'running', exit: d.exit, output: d.output?.output, end: num(d.time?.completed) };
    case 'compaction': return { ...head, role: 'compaction', done: d.status !== 'running', failed: d.status === 'failed' };
    case 'idle': return { ...head, role: 'idle', outcome: d.outcome, error: d.error?.message };
    case 'model-switched': return { ...head, role: 'model', model: d.model?.id };
  }
  return { ...head, role: 'other' }; // synthetic, system, skill, agent/location switches: context, not activity
}

function v1Part(p, key) {
  p = obj(p);
  switch (p.type) {
    case 'text': return { key, kind: 'text', text: String(p.text ?? ''), done: !!p.time?.end, hidden: !!(p.synthetic || p.ignored) };
    case 'reasoning': return { key, kind: 'reasoning', done: !!p.time?.end };
    case 'compaction': return { key, kind: 'compaction' };
    case 'tool': {
      const s = obj(p.state);
      const meta = obj(s.metadata);
      return {
        key, kind: 'tool', id: String(p.callID || key), name: String(p.tool || 'tool'), status: String(s.status || 'pending'),
        input: obj(s.input), ok: s.status === 'completed' && (meta.exit == null || meta.exit === 0),
        output: s.status === 'error' ? String(s.error ?? '') : String(s.output ?? ''),
        start: num(s.time?.start), end: num(s.time?.end),
      };
    }
  }
  return null;
}

export function v1Message(row, partRows = []) {
  const d = obj(parseJson(row.data));
  const head = { id: String(row.id), t: num(d.time?.created) || num(row.time_created), updated: num(row.time_updated) };
  for (const p of partRows) head.updated = Math.max(head.updated, num(p.time_updated));
  const parts = partRows.map((p) => v1Part(parseJson(p.data), String(p.id))).filter(Boolean);
  if (d.role === 'user') {
    // A compaction request is a user message holding a compaction part, not something typed.
    if (parts.some((p) => p.kind === 'compaction')) return { ...head, role: 'compaction', done: true, hasParts: true };
    return { ...head, role: 'user', text: parts.filter((p) => p.kind === 'text' && !p.hidden).map((p) => p.text).join('\n'), hasParts: parts.length > 0 };
  }
  if (d.role === 'assistant') {
    const error = d.error && (d.error.data?.message || d.error.name);
    return {
      ...head, role: 'assistant', done: !!d.time?.completed, finish: d.finish || (error ? 'error' : undefined), error,
      model: d.modelID, tokens: d.tokens, cost: d.cost, cwd: d.path?.cwd,
      summary: d.summary === true, parts: parts.filter((p) => !(p.kind === 'text' && p.hidden)),
    };
  }
  return { ...head, role: 'other' };
}

/* ---------- one session ---------- */

// Running state of one session, shaped like parse.js's Transcript so activity() works on it.
export class OpenCodeTranscript {
  constructor() {
    this.events = [];
    this.pending = new Map(); // tool call id -> tool event still waiting for its result
    this.msgs = new Map();    // message id -> what was already emitted for it, while it is still open
    this.usage = new Map();   // message id -> { out, context, cost }
    this.seq = 0;
    this.model = '';
    this.cwd = '';
    this.firstPrompt = '';
    this.lastPrompt = '';
    this.lastSay = null;
    this.todos = null;
    this.toolCount = 0;
    this.busy = false;  // a turn is open: a prompt or a step that asks for more
    this.phase = null;
    this.firstAt = 0;
    this.lastAt = 0;
  }

  state(id) {
    let st = this.msgs.get(id);
    if (!st) this.msgs.set(id, (st = { said: new Set(), tools: new Map(), prompted: false, noted: false }));
    return st;
  }

  // A message that won't change again: its per-message state isn't needed any more.
  forget(id) { this.msgs.delete(id); }

  get outTokens() { let n = 0; for (const u of this.usage.values()) n += u.out; return n; }
  get cost() { let n = 0; for (const u of this.usage.values()) n += u.cost; return n; }
  get context() { return [...this.usage.values()].findLast((u) => u.context > 0)?.context || 0; }

  ingest(m) {
    const out = [];
    if (!m?.id) return out;
    const st = this.state(m.id);
    const t = m.t || 0;
    switch (m.role) {
      case 'user': {
        const text = String(m.text ?? '').trim();
        if (st.prompted || !text) break;
        st.prompted = true;
        this.lastPrompt = clip(text, 300);
        if (!this.firstPrompt) this.firstPrompt = clip(text, 60);
        this.busy = true;
        this.phase = { kind: 'prompt', t };
        out.push({ kind: 'prompt', text: clip(text, 1500) });
        break;
      }
      case 'assistant': this.assistant(m, st, t, out); break;
      case 'shell': {
        const id = `shell-${m.id}`;
        if (!st.tools.has(id)) {
          st.tools.set(id, 'tool');
          this.tool(id, 'shell', { command: m.command }, t, out);
        }
        if (!m.running && st.tools.get(id) !== 'result') {
          st.tools.set(id, 'result');
          this.result(id, m.exit == null || m.exit === 0, m.output, m.end || t, out);
        }
        break;
      }
      case 'compaction':
        if (m.done && !st.noted) {
          st.noted = true;
          out.push({ kind: 'note', text: m.failed ? 'Context compaction failed' : 'Context compacted' });
        }
        break;
      case 'idle': // 2.x: the end of a turn
        if (st.noted) break;
        st.noted = true;
        this.endTurn(t);
        if (m.outcome === 'interrupted') out.push({ kind: 'note', text: 'Interrupted by user' });
        else if (m.outcome === 'failed') out.push({ kind: 'note', text: clip(m.error || 'The turn failed', 300) });
        break;
      case 'model': if (m.model) this.model = String(m.model); break;
    }

    if (t) {
      if (!this.firstAt) this.firstAt = t;
      this.lastAt = Math.max(this.lastAt, t, m.updated || 0);
    }
    for (const e of out) {
      e.id = `${m.id}:${this.seq++}`;
      e.t = e.t || t || Date.now();
      this.events.push(e);
    }
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return out;
  }

  assistant(m, st, t, out) {
    if (m.model) this.model = String(m.model);
    if (m.cwd) this.cwd = String(m.cwd);
    if (m.tokens || m.cost) this.usage.set(m.id, { ...usageOf(m.tokens), cost: num(m.cost) });
    if (m.summary) { // 1.x: the summary a compaction writes, not a reply
      if (m.done && !st.noted) { st.noted = true; out.push({ kind: 'note', text: 'Context compacted' }); }
      return;
    }
    const parts = m.parts || [];
    parts.forEach((p, i) => {
      if (p.kind === 'reasoning') { // never shown
        if (!p.done) this.phase = { kind: 'thinking', t };
      } else if (p.kind === 'text') {
        // Text streams in place: it is final once the step ends or another part follows it.
        const done = m.done || p.done || i < parts.length - 1;
        const text = p.text.trim();
        if (!done) { if (text) this.phase = { kind: 'writing', t }; return; }
        if (!text || st.said.has(p.key)) return;
        st.said.add(p.key);
        out.push({ kind: 'say', text: clip(text, 2500) });
        this.lastSay = { text: clip(text, 400), t: m.updated || t };
        this.phase = { kind: 'writing', t };
      } else if (p.kind === 'tool') {
        if (p.status === 'pending') return; // the model is still writing the call
        if (!st.tools.has(p.key)) {
          st.tools.set(p.key, 'tool');
          this.tool(p.id, p.name, p.input, p.start || t, out);
        }
        if ((p.status === 'completed' || p.status === 'error') && st.tools.get(p.key) !== 'result') {
          st.tools.set(p.key, 'result');
          this.result(p.id, p.ok, p.output, p.end, out);
        }
      }
    });
    if (m.done) {
      if (FINAL(m.finish)) this.endTurn(m.updated || t);
      else this.busy = true;
      if (m.error && !st.noted) { st.noted = true; out.push({ kind: 'note', text: clip(m.error, 300) }); }
    } else {
      this.busy = true;
    }
  }

  tool(id, name, args, t, out) {
    id = String(id);
    const full = mcpName(name);
    const e = {
      kind: 'tool', toolId: id, name: full, label: toolLabel(full), cat: opencodeCategory(name),
      ...summaryFields(toolSummary(name, args), scrub(args)), detail: clip(toolDetail(name, args), 1500),
    };
    this.pending.set(id, { ...e, t });
    this.toolCount++;
    if (name === 'todowrite' && Array.isArray(args.todos)) {
      this.todos = args.todos.map((x) => ({ content: clip(x?.content, 200), status: TODO_STATUS[x?.status] || 'pending' }));
    }
    out.push(e);
    this.phase = { kind: 'tool', t };
  }

  result(id, ok, text, end, out) {
    id = String(id);
    const p = this.pending.get(id);
    this.pending.delete(id);
    out.push({ kind: 'result', toolId: id, ok: !!ok, text: clip(String(text ?? '').trim(), 900), ms: p?.t && end ? Math.max(0, end - p.t) : null });
    this.phase = { kind: 'result', t: end || p?.t || 0 };
  }

  endTurn(t) {
    this.busy = false;
    this.pending.clear();
    this.phase = { kind: 'done', t };
  }
}

/* ---------- reading the database ---------- */

let sqlite; // node:sqlite, loaded the first time a database is found (undefined: not tried yet)
async function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }
  return sqlite;
}

// One read: opened, queried and closed again, so an opencode that starts or stops in between is
// never read through a stale connection.
function withDb(file, fn) {
  // Without both side files, a read-only open would create the missing one.
  const live = fs.existsSync(`${file}-wal`) && fs.existsSync(`${file}-shm`);
  // A URI string (not a URL object) works on every Node that has node:sqlite.
  const db = new sqlite.DatabaseSync(live ? file : `${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

const MSG_COLS = 'id, type, seq, time_created, time_updated, data';
const V1_MSG_COLS = 'id, time_created, time_updated, data';
const ms = (r) => Math.max(num(r.time_updated), num(r.time_busy), num(r.time_idle));

/* ---------- collector ---------- */

const KEY_SAFE = (s) => String(s).replace(/[^\w.-]/g, '_').slice(0, 80);

// The most recent top-level sessions of one database and their child (subagent) sessions.
function pick(found) {
  const byId = new Map(found.map((f) => [String(f.row.id), f]));
  const rootId = (f) => {
    for (let i = 0; i < 8 && f.row.parent_id && byId.has(String(f.row.parent_id)); i++) f = byId.get(String(f.row.parent_id));
    return String(f.row.id);
  };
  const tops = new Set(found.filter((f) => rootId(f) === String(f.row.id)).sort((a, b) => ms(b.row) - ms(a.row))
    .slice(0, MAX_RECENT).map((f) => String(f.row.id)));
  return found.filter((f) => tops.has(rootId(f)));
}

export class OpenCodeCollector extends EventEmitter {
  sessions = new Map(); // session id -> session record
  dbs = new Map();      // database file -> { stamp }
  up = false;           // an opencode is running (process seen, or its database written just now)
  warned = new Set();
  ticks = 0;
  busyTick = false;

  // running(): whether an opencode process is seen on this machine (ProcessScanner).
  // dir: opencode's data folder, holding opencode.db.
  constructor({ running = () => false, dir = OPENCODE_DIR } = {}) {
    super();
    this.running = running;
    this.dir = dir;
  }

  start() {
    this.tick();
    setInterval(() => this.tick(), 1500);
  }

  warn(id, msg) {
    if (this.warned.has(id)) return;
    this.warned.add(id);
    console.warn(`[opencode] ${msg}`);
  }

  async tick() {
    if (this.busyTick) return;
    this.busyTick = true;
    try {
      let walFresh = false;
      for (const file of opencodeDbs(this.dir)) {
        const wal = statOf(`${file}-wal`);
        if (wal && Date.now() - wal.mtimeMs < WAL_FRESH_MS && fs.existsSync(`${file}-shm`)) walFresh = true;
        await this.scanDb(file);
      }
      this.up = walFresh || !!this.running();
      this.prune();
    } catch (e) {
      console.error('[opencode] tick failed:', e);
    } finally {
      this.busyTick = false;
      this.ticks++;
      this.emit('tick');
    }
  }

  async scanDb(file) {
    const st = statOf(file);
    if (!st) return;
    const sq = await loadSqlite();
    if (!sq) {
      this.warn('sqlite', `opencode keeps its sessions in SQLite, which needs Node 22.13 or newer (this is ${process.version}). opencode is only shown as a process.`);
      return;
    }
    const wal = statOf(`${file}-wal`);
    const stamp = `${st.mtimeMs}:${st.size}:${wal?.mtimeMs || 0}:${wal?.size || 0}`;
    const state = this.dbs.get(file) || { stamp: '', keep: new Set() };
    this.dbs.set(file, state);
    if (state.stamp === stamp && this.ticks % 20) return; // unchanged; still re-read every 30s
    state.stamp = stamp;
    try {
      withDb(file, (db) => {
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
        const since = Date.now() - RECENT_MS;
        const found = [];
        const v2 = tables.has('session_v2') && tables.has('session_message');
        if (v2) {
          // time_busy / time_idle arrived in 2.x builds from 2026-10-29; time_updated stays put on them.
          const cols = new Set(db.prepare('PRAGMA table_info(session_v2)').all().map((c) => c.name));
          const order = cols.has('time_busy') && cols.has('time_idle')
            ? 'MAX(time_updated, COALESCE(time_busy, 0), COALESCE(time_idle, 0))' : 'time_updated';
          const rows = db.prepare(`SELECT * FROM session_v2 WHERE time_archived IS NULL ORDER BY ${order} DESC LIMIT 40`).all();
          const read = this.v2Reader(db, tables.has('session_part'));
          found.push(...rows.filter((r) => ms(r) >= since).map((row) => ({ schema: 'v2', row, read })));
        }
        if (tables.has('session') && tables.has('message') && tables.has('part')) {
          // A 2.x database keeps its migrated 1.x tables: those sessions are read from session_v2.
          const inV2 = v2 ? db.prepare('SELECT 1 FROM session_v2 WHERE id = ?') : null;
          const rows = db.prepare('SELECT * FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 40').all();
          const read = this.v1Reader(db);
          found.push(...rows.filter((r) => ms(r) >= since && !inV2?.get(r.id)).map((row) => ({ schema: 'v1', row, read })));
        }
        const picked = pick(found);
        state.keep = new Set(picked.map((f) => String(f.row.id)));
        // Every session is known before any is read, so a child gets its parent's key from the start.
        const sessions = picked.map((f) => [this.session(file, f.schema, f.row), f.read]);
        for (const [s, read] of sessions) this.readSession(s, read);
      });
    } catch (e) {
      this.warn(`db:${file}`, `Couldn't read ${file}: ${e.message}`);
    }
  }

  // Readers return normalized messages: the newest ones (first read), those after a cursor, and
  // the still-open ones again.
  v2Reader(db, partRows) {
    const latest = db.prepare(`SELECT ${MSG_COLS} FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT ${INITIAL_MESSAGES}`);
    const after = db.prepare(`SELECT ${MSG_COLS} FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 500`);
    const one = db.prepare(`SELECT ${MSG_COLS} FROM session_message WHERE id = ?`);
    const maxSeq = db.prepare('SELECT MAX(seq) AS n FROM session_message WHERE session_id = ?');
    const parts = partRows ? db.prepare('SELECT ordinal, type, call_id, time_updated, data FROM session_part WHERE message_id = ? ORDER BY ordinal') : null;
    const norm = (r) => v2Message(r, r.type === 'assistant' && parts ? parts.all(r.id) : []);
    return (s) => {
      const max = maxSeq.get(s.id)?.n;
      if (s.cursor != null && (max == null || max < s.cursor)) this.reset(s); // history was rewritten (revert)
      const rows = s.cursor == null ? latest.all(s.id).reverse() : after.all(s.id, s.cursor);
      const reread = [...s.open.keys()].map((id) => one.get(id)).filter((r) => r && (s.cursor == null || r.seq <= s.cursor));
      if (rows.length) s.cursor = num(rows.at(-1).seq);
      else if (s.cursor == null) s.cursor = -1;
      return [...reread, ...rows].sort((a, b) => num(a.seq) - num(b.seq)).map(norm);
    };
  }

  v1Reader(db) {
    const latest = db.prepare(`SELECT ${V1_MSG_COLS} FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ${INITIAL_MESSAGES}`);
    const after = db.prepare(`SELECT ${V1_MSG_COLS} FROM message WHERE session_id = ? AND (time_created > ? OR (time_created = ? AND id > ?))
      ORDER BY time_created, id LIMIT 500`);
    const one = db.prepare(`SELECT ${V1_MSG_COLS} FROM message WHERE id = ?`);
    const parts = db.prepare('SELECT id, time_updated, data FROM part WHERE message_id = ? ORDER BY id');
    const norm = (r) => v1Message(r, parts.all(r.id));
    return (s) => {
      const c = s.cursor;
      const rows = c == null ? latest.all(s.id).reverse() : after.all(s.id, c.t, c.t, c.id);
      const reread = [...s.open.keys()].map((id) => one.get(id)).filter(Boolean);
      if (rows.length) s.cursor = { t: num(rows.at(-1).time_created), id: String(rows.at(-1).id) };
      else if (c == null) s.cursor = { t: 0, id: '' };
      const seen = new Set(rows.map((r) => r.id));
      return [...reread.filter((r) => !seen.has(r.id)), ...rows]
        .sort((a, b) => num(a.time_created) - num(b.time_created) || String(a.id).localeCompare(String(b.id))).map(norm);
    };
  }

  session(file, schema, row) {
    const id = String(row.id);
    let s = this.sessions.get(id);
    if (!s || s.file !== file || s.schema !== schema) {
      s = { id, file, schema, row, tr: new OpenCodeTranscript(), cursor: null, open: new Map(), updatedAt: 0 };
      this.sessions.set(id, s);
    }
    s.row = row;
    s.updatedAt = ms(row);
    return s;
  }

  readSession(s, read) {
    const msgs = read(s);
    const events = [];
    msgs.forEach((msg, i) => {
      events.push(...s.tr.ingest(msg));
      if (this.isClosed(msg, i < msgs.length - 1)) {
        s.open.delete(msg.id);
        s.tr.forget(msg.id);
      } else {
        s.open.set(msg.id, true);
      }
    });
    while (s.open.size > MAX_OPEN) { // a message left unfinished by a crash: stop re-reading it
      const oldest = s.open.keys().next().value;
      s.open.delete(oldest);
      s.tr.forget(oldest);
    }
    if (events.length) this.emit('events', this.keyOf(s), events);
  }

  // A message that won't change any more. `later`: a newer message exists.
  isClosed(m, later) {
    switch (m.role) {
      case 'assistant': return m.done && m.parts.every((p) => p.kind !== 'tool' || p.status === 'completed' || p.status === 'error');
      case 'shell': return !m.running;
      case 'compaction': return m.done;
      case 'user': return m.hasParts === false ? later : true; // 1.x writes the text as a part after the message
    }
    return true;
  }

  reset(s) {
    s.tr = new OpenCodeTranscript();
    s.cursor = null;
    s.open.clear();
  }

  // Sessions the last read of their database didn't pick, or whose database is gone.
  prune() {
    const files = new Set(opencodeDbs(this.dir));
    for (const [id, s] of this.sessions) {
      if (!files.has(s.file) || !this.dbs.get(s.file)?.keep.has(id) || Date.now() - this.lastAt(s) > RECENT_MS) this.sessions.delete(id);
    }
  }

  // The top-level session a child (subagent) session hangs under: its oldest shown ancestor.
  rootOf(s) {
    let p = s;
    for (let i = 0; i < 8 && p.row.parent_id; i++) {
      const next = this.sessions.get(String(p.row.parent_id));
      if (!next) break;
      p = next;
    }
    return p !== s ? p : null;
  }

  keyOf(s) {
    const root = this.rootOf(s);
    return root ? `opencode:${KEY_SAFE(root.id)}/${KEY_SAFE(s.id)}` : `opencode:${KEY_SAFE(s.id)}`;
  }

  lastAt(s) { return Math.max(s.tr.lastAt, s.updatedAt); }

  // 2.x records the turn on the session row (time_busy / time_idle); 1.x only in its messages.
  rawBusy(s) {
    const r = s.row;
    if (s.schema === 'v2' && r.time_busy !== undefined) return r.time_busy != null && (r.time_idle == null || r.time_busy > r.time_idle);
    return s.tr.busy;
  }

  busy(s, children = []) {
    const last = Math.max(this.lastAt(s), ...children.map((c) => this.lastAt(c)));
    return this.rawBusy(s) && Date.now() - last < BUSY_MS;
  }

  live(s, children) {
    return this.up && (this.busy(s, children) || Date.now() - this.lastAt(s) < LIVE_IDLE_MS);
  }

  status(s, children = []) {
    if (!this.live(s, children)) return 'offline';
    if (!this.busy(s, children)) return 'idle';
    const p = [...s.tr.pending.values()].at(-1);
    return p?.name === 'question' ? 'waiting' : 'working';
  }

  hasLive() {
    const subs = this.children();
    return [...this.sessions.values()].some((s) => !this.rootOf(s) && this.live(s, subs.get(s.id) || []));
  }

  allEvents(limit) {
    const out = {};
    for (const s of this.sessions.values()) out[this.keyOf(s)] = s.tr.events.slice(-limit);
    return out;
  }

  children() {
    const subs = new Map();
    for (const s of this.sessions.values()) {
      const root = this.rootOf(s);
      if (root) (subs.get(root.id) || subs.set(root.id, []).get(root.id)).push(s);
    }
    return subs;
  }

  snapshot() {
    const subs = this.children();
    return [...this.sessions.values()].filter((s) => !this.rootOf(s))
      .sort((a, b) => this.lastAt(b) - this.lastAt(a)).slice(0, MAX_RECENT) // across several databases
      .map((s) => this.summarize(s, subs.get(s.id) || []));
  }

  totals(s) {
    const r = s.row;
    const out = num(r.tokens_output) || s.tr.outTokens;
    const cost = num(r.cost) || s.tr.cost;
    return { outTokens: out, cost: cost > 0 ? cost : null };
  }

  summarize(s, subs) {
    const { tr, row: r } = s;
    const status = this.status(s, subs);
    const dir = typeof r.directory === 'string' && r.directory ? platformPath(r.directory) : '';
    const cwd = (dir && r.path ? path.join(dir, String(r.path)) : dir) || tr.cwd;
    // opencode titles sessions itself, from the first prompt (session/title.ts); a rename looks the
    // same, so a title is treated like a name made from a prompt and stays here below full.
    const title = typeof r.title === 'string' && !/^(New session|Child session) - \d{4}-/.test(r.title) ? r.title : '';
    const derived = title || tr.firstPrompt;
    const model = tr.model || String(obj(parseJson(r.model)).id || '');
    const { outTokens, cost } = this.totals(s);
    return {
      key: this.keyOf(s),
      sessionId: s.id,
      pid: null,
      live: this.live(s, subs),
      kind: 'opencode',
      canMessage: false,
      name: derived || path.basename(cwd) || s.id.slice(0, 12),
      nameFromPrompt: !!derived,
      title: '',
      project: path.basename(cwd),
      cwd,
      branch: '',
      model,
      version: String(r.version || ''),
      status,
      rawStatus: this.rawBusy(s) ? 'busy' : String(r.idle_outcome || ''),
      now: activity(tr, status, {
        since: tr.phase?.t || tr.lastAt,
        detail: status === 'waiting' ? [...tr.pending.values()].at(-1)?.summary : undefined,
      }),
      lastSay: tr.lastSay,
      lastPrompt: tr.lastPrompt,
      prs: [],
      todos: tr.todos,
      outTokens,
      cost,
      context: tr.context,
      toolCount: tr.toolCount,
      startedAt: num(r.time_created) || tr.firstAt,
      lastAt: this.lastAt(s),
      job: null,
      subagents: subs.sort((a, b) => this.lastAt(b) - this.lastAt(a)).map((c) => {
        const st = this.rawBusy(c) && status !== 'offline' && this.busy(c) ? 'working' : c.tr.toolCount || c.tr.lastSay ? 'done' : 'idle';
        const ct = typeof c.row.title === 'string' && !/^(New session|Child session) - \d{4}-/.test(c.row.title) ? c.row.title : '';
        const totals = this.totals(c);
        return {
          key: this.keyOf(c),
          agentId: KEY_SAFE(c.id),
          type: String(c.row.agent || 'subagent'),
          description: ct, // the subagent tool's short description of the task
          toolUseId: null,
          status: st,
          now: activity(c.tr, st),
          model: c.tr.model || String(obj(parseJson(c.row.model)).id || ''),
          outTokens: totals.outTokens,
          cost: totals.cost,
          context: c.tr.context,
          toolCount: c.tr.toolCount,
          startedAt: num(c.row.time_created) || c.tr.firstAt,
          lastAt: this.lastAt(c),
        };
      }),
    };
  }
}
