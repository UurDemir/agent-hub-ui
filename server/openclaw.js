// Watches OpenClaw's local sessions ($OPENCLAW_STATE_DIR, default ~/.openclaw). OpenClaw is a
// self-hosted assistant gateway: one long-running process owns every session.
// - Current versions keep sessions in a per-agent SQLite database,
//   agents/<agentId>/agent/openclaw-agent.sqlite (tables session_nodes and transcript_events; large
//   rows zstd-compressed). Reading it needs node:sqlite (Node 22.13+) and zstd (Node 22.15+); on an
//   older Node, OpenClaw is only detected as a process.
// - Older versions (up to 2026.7.x) keep agents/<agentId>/sessions/sessions.json and one JSONL
//   transcript per session, which any Node can read.
// Both store the same transcript entries (pi's session format). The format was read from
// github.com/openclaw/openclaw's sources (src/state/openclaw-agent-schema.sql, src/config/sessions,
// packages/agent-core). Read-only: the database is opened read-only, and with immutable=1 when no
// gateway is writing it, so SQLite doesn't create its -wal/-shm files either.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { Tail, activity, clip, toolLabel } from './parse.js';

const env = process.env;
const HOME = env.OPENCLAW_HOME || os.homedir();
const PROFILE = (env.OPENCLAW_PROFILE || '').trim();
export const OPENCLAW_DIR = env.OPENCLAW_STATE_DIR?.trim()
  || path.join(HOME, PROFILE && PROFILE.toLowerCase() !== 'default' ? `.openclaw-${PROFILE}` : '.openclaw');
const RECENT_MS = 3 * 3600e3;   // sessions active this recently are shown
const MAX_RECENT = 10;
const BUSY_MS = 15 * 60e3;      // a run with no new entry for this long no longer counts as working
const HEARTBEAT_STALE_MS = 90e3; // the gateway touches its lock files every 15s
const INITIAL_ROWS = 300;
const MAX_EVENTS = 400;

const readdir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const statOf = (f) => { try { return fs.statSync(f); } catch { return null; } };
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const firstLine = (s) => String(s ?? '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
const base = (p) => (p ? path.basename(String(p)) : '');
const ms = (v) => (typeof v === 'number' && v > 0 ? (v < 1e12 ? v * 1000 : v) : 0);

/* ---------- tools ---------- */

const CATEGORY = {
  read: 'read', ls: 'read', find: 'read', grep: 'read', search: 'read', glob: 'read', view_image: 'read', pdf: 'read',
  memory_search: 'read', memory_get: 'read', sessions_list: 'read', sessions_history: 'read', sessions_search: 'read',
  skills_read: 'read', skills_search: 'read', tool_search: 'read',
  write: 'edit', edit: 'edit', apply_patch: 'edit',
  exec: 'run', bash: 'run', process: 'run', code_execution: 'run', terminal: 'run', computer: 'run',
  web_search: 'web', web_fetch: 'web', x_search: 'web', browser: 'web',
  sessions_spawn: 'agent', subagents: 'agent', sessions_send: 'agent', sessions_yield: 'agent', agents_wait: 'agent',
  agents_list: 'agent', sessions_create: 'agent',
  create_goal: 'plan', update_goal: 'plan', get_goal: 'plan', progress_card: 'plan', suggest_task: 'plan', dismiss_task: 'plan',
  ask_user: 'ask',
};
// MCP tools are <server>__<tool> (mcp__<server>__<tool> from a claude-cli harness).
const mcpName = (name) => (!name.startsWith('mcp__') && /^[^_].*__./.test(name) ? `mcp__${name}` : name);
export const openclawCategory = (name) => (mcpName(name).startsWith('mcp__') ? 'mcp' : CATEGORY[name] || 'other');

// Arguments can carry secrets (exec's env, a browser's headers): those keys never leave the collector.
const SECRET_KEY = /env|header|cookie|secret|token|passw|api[_-]?key|auth|credential/i;
const scrub = (v, depth = 0) => {
  if (Array.isArray(v)) return depth > 6 ? [] : v.map((x) => scrub(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  return depth > 6 ? {} : Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_KEY.test(k)).map(([k, x]) => [k, scrub(x, depth + 1)]));
};
// Summaries are shared from the activity level, so other tools only get one of these plain fields.
const SAFE_SUMMARY = ['path', 'pattern', 'query', 'action'];
const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
const patchFiles = (patch) => [...String(patch).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());

function toolSummary(name, a) {
  switch (name) {
    case 'read': case 'write': case 'edit': case 'view_image': case 'pdf': return base(a.path);
    case 'ls': return base(a.path) || '.';
    case 'grep': return `"${a.pattern ?? ''}"${a.path ? ' in ' + base(a.path) : ''}`;
    case 'find': case 'glob': return a.pattern;
    case 'exec': case 'bash': return firstLine(a.command);
    case 'process': return [a.action, a.sessionId].filter(Boolean).join(' ');
    case 'apply_patch': return patchFiles(a.input).map(base).join(', ');
    case 'web_search': case 'x_search': return a.query;
    case 'web_fetch': return host(a.url);
    case 'browser': return [a.action, host(a.url)].filter(Boolean).join(' ');
    case 'sessions_spawn': return [a.label, a.agentId].filter(Boolean).join(' · ') || 'Subagent'; // the task is a prompt
    case 'sessions_send': return 'Message to a session';
    case 'message': return 'Sending a message';
    case 'ask_user': return 'Question';
  }
  const k = SAFE_SUMMARY.find((x) => typeof a[x] === 'string');
  return k ? firstLine(k === 'path' ? base(a[k]) : a[k]) : '';
}

function toolDetail(name, a) {
  switch (name) {
    case 'exec': case 'bash': return `${a.command ?? ''}${a.workdir ? `\n(in ${a.workdir})` : ''}`;
    case 'apply_patch': return String(a.input ?? '');
    case 'edit': return `${a.path}\n${(a.edits || []).map((e) => `- ${clip(e.oldText, 300)}\n+ ${clip(e.newText, 300)}`).join('\n')}`;
    case 'write': return `${a.path}\n${String(a.content ?? '').split('\n').length} lines`;
  }
  return JSON.stringify(scrub(a), null, 1);
}

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content)
  ? content.map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n') : '');

/* ---------- one transcript ---------- */

// Running state of one session, shaped like parse.js's Transcript so activity() works on it.
export class OpenClawTranscript {
  constructor() {
    this.events = [];
    this.pending = new Map(); // toolCall id -> tool event waiting for its toolResult
    this.seen = new Set();    // entry ids already ingested
    this.seq = 0;
    this.cwd = '';
    this.model = '';
    this.name = '';
    this.firstPrompt = '';
    this.lastPrompt = '';
    this.lastSay = null;
    this.outTokens = 0;
    this.context = 0;
    this.cost = 0;
    this.priced = false;
    this.toolCount = 0;
    this.busy = false; // a run is in progress: the last entry asks for more (prompt, tool call, tool result)
    this.phase = null;
    this.firstAt = 0;
    this.lastAt = 0;
  }

  ingest(j) {
    const out = [];
    if (!j || typeof j !== 'object') return out;
    if (j.id && this.seen.has(j.id)) return out;
    if (j.id) this.seen.add(j.id);
    const t = Date.parse(j.timestamp) || 0;

    switch (j.type) {
      case 'session': if (j.cwd) this.cwd = String(j.cwd); break;
      case 'model_change': if (j.modelId) this.model = String(j.modelId); break;
      case 'session_info': if (typeof j.name === 'string') this.name = j.name; break;
      case 'compaction': out.push({ kind: 'note', text: 'Context compacted' }); break;
      case 'message': this.message(j.message, t, out); break;
    }

    if (t && j.type === 'message') {
      if (!this.firstAt) this.firstAt = t;
      this.lastAt = Math.max(this.lastAt, t);
    }
    for (const e of out) {
      e.id = `${j.id || 'r'}:${this.seq++}`;
      e.t = e.t || t || Date.now();
      this.events.push(e);
    }
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return out;
  }

  message(m, t, out) {
    if (!m || typeof m !== 'object') return;
    switch (m.role) {
      case 'user': {
        if (m.synthetic || m.runtimeContext || m.runtimeContextCarrier) return; // context the host injected
        const text = textOf(m.content).trim();
        if (!text) return;
        this.lastPrompt = clip(text, 300);
        if (!this.firstPrompt) this.firstPrompt = clip(text, 60);
        this.busy = true;
        this.phase = { kind: 'prompt', t };
        out.push({ kind: 'prompt', text: clip(text, 1500) });
        return;
      }
      case 'assistant': return this.assistant(m, t, out);
      case 'toolResult': {
        const id = String(m.toolCallId ?? '');
        const p = this.pending.get(id);
        this.pending.delete(id);
        out.push({ kind: 'result', toolId: id, ok: !m.isError, text: clip(textOf(m.content).trim(), 900), ms: p && t ? t - p.t : null });
        this.phase = { kind: 'result', t };
        return;
      }
      case 'bashExecution': { // a command the user ran themselves
        const id = `bash-${this.seq}`;
        this.tool(id, 'bash', { command: m.command }, t, out);
        this.pending.delete(id);
        out.push({ kind: 'result', toolId: id, ok: m.exitCode === 0 && !m.cancelled, text: clip(String(m.output ?? '').trim(), 900), ms: null });
      }
    }
  }

  assistant(m, t, out) {
    if (m.model) this.model = String(m.model);
    const u = m.usage;
    if (u && typeof u === 'object') {
      this.outTokens += Number(u.output) || 0;
      this.context = Number(u.contextUsage?.promptTokens) || (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
      if (typeof u.cost?.total === 'number') { this.cost += u.cost.total; this.priced = true; }
    }
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type === 'thinking') this.phase = { kind: 'thinking', t }; // hidden reasoning: never shown
      else if (c?.type === 'text' && c.text?.trim()) {
        out.push({ kind: 'say', text: clip(c.text.trim(), 2500) });
        this.lastSay = { text: clip(c.text.trim(), 400), t };
        this.phase = { kind: 'writing', t };
      } else if (c?.type === 'toolCall') {
        this.tool(c.id, String(c.name || 'tool'), c.arguments && typeof c.arguments === 'object' ? c.arguments : {}, t, out);
      }
    }
    if (m.stopReason === 'toolUse') this.busy = true;
    else if (m.stopReason) {
      this.busy = false;
      this.pending.clear();
      this.phase = { kind: 'done', t };
      if (m.stopReason === 'error') out.push({ kind: 'note', text: clip(m.errorMessage || 'The model returned an error', 300) });
      else if (m.stopReason === 'aborted') out.push({ kind: 'note', text: 'Run aborted' });
    }
  }

  tool(id, name, args, t, out) {
    id = String(id || `call-${this.seq}`);
    const full = mcpName(name);
    const cat = openclawCategory(name);
    const e = {
      kind: 'tool', toolId: id, name: full, label: toolLabel(full), cat,
      summary: clip(toolSummary(name, args), 180), detail: clip(toolDetail(name, args), 1500),
    };
    this.pending.set(id, { ...e, t });
    this.toolCount++;
    out.push(e);
    this.phase = { kind: 'tool', t };
  }
}

/* ---------- reading the stores ---------- */

let sqlite; // node:sqlite, loaded the first time a database is found (undefined: not tried yet)
async function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }
  return sqlite;
}

// One read of an agent's database: opened, queried and closed again, so a gateway that starts or
// stops in between is never read through a stale connection.
function withDb(file, fn) {
  // Without both side files, a read-only open would create the missing one.
  const live = fs.existsSync(`${file}-wal`) && fs.existsSync(`${file}-shm`);
  // A URI string (not a URL object) works on every Node that has node:sqlite.
  const db = new sqlite.DatabaseSync(live ? file : `${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

const zstdOk = typeof zlib.zstdDecompressSync === 'function';
function rowJson(row) {
  if (typeof row.event_json === 'string') return parseJson(row.event_json);
  if (!row.event_zstd || !zstdOk) return null; // archived, or zstd needs Node 22.15+
  try {
    return parseJson(zlib.zstdDecompressSync(row.event_zstd, { maxOutputLength: Math.min(4194304, Math.max(1, Number(row.event_utf8_bytes) || 4194304)) }).toString('utf8'));
  } catch { return null; }
}

/* ---------- collector ---------- */

// Keys use the session id, never the session key: a chat session's key names the contact or group
// (agent:main:telegram:direct:<peer>), and keys are shared even at the metadata level.
const KEY_SAFE = (s) => String(s).replace(/[^\w.-]/g, '_').slice(0, 80);

export class OpenClawCollector extends EventEmitter {
  sessions = new Map(); // `${agentId}\n${sessionKey}` -> session record
  gatewayUp = false;
  warned = new Set();
  ticks = 0;
  busyTick = false;

  // running(): whether an OpenClaw process is seen on this machine (ProcessScanner).
  constructor({ running = () => false, dir = OPENCLAW_DIR } = {}) {
    super();
    this.running = running;
    this.dir = dir;
  }

  start() {
    this.tick();
    setInterval(() => this.tick(), 2000);
  }

  warn(id, msg) {
    if (this.warned.has(id)) return;
    this.warned.add(id);
    console.warn(`[openclaw] ${msg}`);
  }

  async tick() {
    if (this.busyTick) return;
    this.busyTick = true;
    try {
      this.gatewayUp = this.heartbeat() || this.running();
      for (const agentId of readdir(path.join(this.dir, 'agents'))) await this.scanAgent(agentId);
      this.prune();
    } catch (e) {
      console.error('[openclaw] tick failed:', e);
    } finally {
      this.busyTick = false;
      this.ticks++;
      this.emit('tick');
    }
  }

  // The gateway refreshes its lock files under <state>/tmp/openclaw[-<uid>]/ every 15 seconds.
  heartbeat() {
    const tmp = path.join(this.dir, 'tmp');
    const now = Date.now();
    for (const d of readdir(tmp)) {
      if (!d.startsWith('openclaw')) continue;
      for (const f of readdir(path.join(tmp, d))) {
        if (!f.startsWith('gateway.') || !f.endsWith('.lock')) continue;
        const st = statOf(path.join(tmp, d, f));
        if (st && now - st.mtimeMs < HEARTBEAT_STALE_MS) return true;
      }
    }
    return false;
  }

  async scanAgent(agentId) {
    const dbFile = path.join(this.dir, 'agents', agentId, 'agent', 'openclaw-agent.sqlite');
    const db = statOf(dbFile);
    if (db) {
      const sq = await loadSqlite();
      if (!sq) {
        this.warn('sqlite', `OpenClaw keeps its sessions in SQLite, which needs Node 22.13 or newer (this is ${process.version}). OpenClaw is only shown as a process.`);
      } else if (this.scanDb(agentId, dbFile, db)) {
        return;
      }
    }
    this.scanLegacy(agentId);
  }

  // Returns false when the database has no sessions yet (an older OpenClaw keeps them in JSONL).
  scanDb(agentId, file, st) {
    const wal = statOf(`${file}-wal`);
    const stamp = `${st.mtimeMs}:${st.size}:${wal?.mtimeMs || 0}:${wal?.size || 0}`;
    const state = (this.dbs ??= new Map()).get(file) || { stamp: '', tables: null };
    this.dbs.set(file, state);
    if (state.tables === false) return false;
    if (state.stamp === stamp && this.ticks % 15) return true; // unchanged; still re-read every 30s for status
    state.stamp = stamp;
    try {
      withDb(file, (db) => {
        if (state.tables === null) {
          state.tables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_nodes'").get();
          if (!state.tables) return;
        }
        const since = Date.now() - RECENT_MS;
        const rows = db.prepare(`SELECT session_key, current_session_id, entry_json, status, parent_session_key, spawned_by,
            label, display_name, updated_at, last_activity_at, created_at
          FROM session_nodes WHERE archived_at IS NULL
          ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT 40`).all()
          .filter((r) => Math.max(ms(r.last_activity_at), ms(r.updated_at)) >= since);
        const lastSeq = db.prepare('SELECT MAX(seq) AS n FROM transcript_events WHERE session_id = ?');
        const header = db.prepare('SELECT event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = ? AND seq = 0');
        const after = db.prepare('SELECT seq, event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 2000');
        for (const r of rows) {
          const entry = parseJson(r.entry_json) || {};
          const s = this.session(agentId, String(r.session_key), String(r.current_session_id));
          s.entry = entry;
          s.row = r;
          s.updatedAt = Math.max(ms(r.last_activity_at), ms(r.updated_at), ms(entry.updatedAt));
          s.parentKey = r.parent_session_key || entry.parentSessionKey || r.spawned_by || entry.spawnedBy || null;
          const max = Number(lastSeq.get(s.sessionId)?.n ?? -1);
          if (max < s.cursor) this.reset(s); // the transcript was rewritten
          if (s.cursor < 0) {
            const h = header.get(s.sessionId);
            if (h) this.feed(s, [rowJson(h)]);
            s.cursor = Math.max(0, max - INITIAL_ROWS);
          }
          const recs = after.all(s.sessionId, s.cursor);
          if (recs.length) {
            s.cursor = Number(recs.at(-1).seq);
            this.feed(s, recs.map(rowJson));
          }
        }
      });
    } catch (e) {
      this.warn(`db:${file}`, `Couldn't read ${file}: ${e.message}`);
    }
    return state.tables !== false;
  }

  // OpenClaw up to 2026.7.x: sessions.json plus a JSONL transcript per session.
  scanLegacy(agentId) {
    const dir = path.join(this.dir, 'agents', agentId, 'sessions');
    const indexFile = path.join(dir, 'sessions.json');
    const st = statOf(indexFile);
    if (!st) return;
    const prev = (this.indexes ??= new Map()).get(indexFile);
    let index = prev?.index;
    if (!prev || prev.mtime !== st.mtimeMs) {
      try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { index = prev?.index || {}; }
      this.indexes.set(indexFile, { mtime: st.mtimeMs, index });
    }
    const since = Date.now() - RECENT_MS;
    for (const [key, entry] of Object.entries(index || {})) {
      if (!entry?.sessionId || ms(entry.updatedAt) < since) continue;
      // The transcript lives next to sessions.json; sessionFile is only trusted for its file name.
      const name = entry.sessionFile && /\.jsonl$/.test(entry.sessionFile) ? path.basename(entry.sessionFile)
        : /^[\w.-]+$/.test(String(entry.sessionId)) ? `${entry.sessionId}.jsonl` : null;
      if (!name) continue;
      const file = path.join(dir, name);
      const s = this.session(agentId, key, String(entry.sessionId));
      s.entry = entry;
      s.updatedAt = ms(entry.updatedAt);
      s.parentKey = entry.parentSessionKey || entry.spawnedBy || null;
      if (!s.tail || s.tail.file !== file) s.tail = new Tail(file, 1024 * 1024);
      const recs = s.tail.read();
      if (recs.length) this.feed(s, recs);
      s.updatedAt = Math.max(s.updatedAt, s.tail.mtime);
    }
  }

  session(agentId, sessionKey, sessionId) {
    const id = `${agentId}\n${sessionKey}`;
    let s = this.sessions.get(id);
    if (s && s.sessionId !== sessionId) { // a reset starts a new transcript under the same key
      s.sessionId = sessionId;
      this.reset(s);
    }
    if (!s) {
      s = { id, agentId, sessionKey, sessionId, tr: new OpenClawTranscript(), cursor: -1, tail: null, entry: {}, row: null, updatedAt: 0, parentKey: null };
      this.sessions.set(id, s);
    }
    return s;
  }

  reset(s) {
    s.tr = new OpenClawTranscript();
    s.cursor = -1;
    s.tail = null;
  }

  feed(s, records) {
    const events = [];
    for (const r of records) if (r) events.push(...s.tr.ingest(r));
    if (events.length) this.emit('events', this.keyOf(s), events);
  }

  prune() {
    const now = Date.now();
    const tops = [...this.sessions.values()].filter((s) => !this.parentOf(s)).sort((a, b) => b.updatedAt - a.updatedAt);
    const keep = new Set(tops.slice(0, MAX_RECENT).map((s) => s.id));
    for (const [id, s] of this.sessions) {
      const top = this.parentOf(s) || s;
      if (!keep.has(top.id) || now - s.updatedAt > RECENT_MS) this.sessions.delete(id);
    }
  }

  parentOf(s) {
    if (!s.parentKey) return null;
    const p = this.sessions.get(`${s.agentId}\n${s.parentKey}`);
    return p && !p.parentKey ? p : null;
  }

  keyOf(s) {
    const p = this.parentOf(s);
    return p ? `openclaw:${KEY_SAFE(p.sessionId)}/${KEY_SAFE(s.sessionId)}` : `openclaw:${KEY_SAFE(s.sessionId)}`;
  }

  hasLive() { return this.gatewayUp && this.sessions.size > 0; }

  allEvents(limit) {
    const out = {};
    for (const s of this.sessions.values()) out[this.keyOf(s)] = s.tr.events.slice(-limit);
    return out;
  }

  status(s) {
    if (!this.gatewayUp) return 'offline';
    const { tr } = s;
    if (!tr.busy || Date.now() - Math.max(tr.lastAt, s.updatedAt) > BUSY_MS) return 'idle';
    const p = [...tr.pending.values()].at(-1);
    return p?.name === 'ask_user' ? 'waiting' : 'working';
  }

  snapshot() {
    const subs = new Map();
    const tops = [];
    for (const s of this.sessions.values()) {
      const p = this.parentOf(s);
      if (p) (subs.get(p.id) || subs.set(p.id, []).get(p.id)).push(s);
      else tops.push(s);
    }
    return tops.map((s) => this.summarize(s, subs.get(s.id) || []));
  }

  summarize(s, subs) {
    const { tr, entry: e } = s;
    const status = this.status(s);
    const cwd = tr.cwd || String(e.spawnedCwd || e.execCwd || '');
    // Only a label the user set is safe to share as a name. Display names and subjects can be a
    // contact or group name, and auto labels and session_info names come from the conversation, so
    // those are marked like a name made from a prompt and stay on this machine below full.
    const given = String(s.row?.label || e.label || '');
    const derived = String(s.row?.display_name || e.displayName || e.subject || tr.name || e.autoLabel || tr.firstPrompt || '');
    const key = this.keyOf(s);
    return {
      key,
      sessionId: s.sessionId,
      pid: null,
      live: this.gatewayUp,
      kind: 'openclaw',
      canMessage: false,
      name: given || derived || `${s.agentId} session`,
      nameFromPrompt: !given && !!derived,
      title: given,
      project: String(e.channel || e.lastChannel || '') || path.basename(cwd) || s.agentId, // a chat session's channel
      cwd,
      branch: String(e.worktree?.branch || ''),
      model: tr.model || String(e.model || ''),
      version: '',
      status,
      rawStatus: String(s.row?.status || e.status || ''),
      now: activity(tr, status, { since: tr.phase?.t || tr.lastAt }),
      lastSay: tr.lastSay,
      lastPrompt: tr.lastPrompt,
      prs: [],
      todos: null,
      outTokens: tr.outTokens,
      cost: tr.priced ? tr.cost : null,
      context: tr.context,
      toolCount: tr.toolCount,
      startedAt: ms(e.sessionStartedAt) || ms(e.createdAt) || tr.firstAt,
      lastAt: Math.max(tr.lastAt, s.updatedAt),
      job: null,
      subagents: subs.sort((a, b) => b.updatedAt - a.updatedAt).map((c) => {
        const st = this.status(c) === 'working' ? 'working' : c.tr.busy ? 'idle' : 'done';
        return {
          key: this.keyOf(c),
          agentId: KEY_SAFE(c.sessionId),
          type: String(c.entry.subagentRole || 'subagent'),
          description: String(c.row?.label || c.entry.label || ''),
          toolUseId: null,
          status: st,
          now: activity(c.tr, st),
          model: c.tr.model,
          outTokens: c.tr.outTokens,
          cost: c.tr.priced ? c.tr.cost : null,
          context: c.tr.context,
          toolCount: c.tr.toolCount,
          startedAt: c.tr.firstAt,
          lastAt: Math.max(c.tr.lastAt, c.updatedAt),
        };
      }),
    };
  }
}
