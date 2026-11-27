// Watches Google Gemini CLI's local chat recordings ($GEMINI_CLI_HOME/.gemini, default ~/.gemini).
// Each project gets tmp/<project id>/ (a slug of the folder name, or the sha256 of its path in old
// versions); the slug folder holds .project_root with the project's path. Chats are
// tmp/<id>/chats/session-<time>-<short id>.jsonl, append-only: a metadata line, then message
// records. A message is appended again, whole, each time it changes (tokens, tool calls scheduled,
// then finished), so everything is deduped by message and tool call id. Older versions (before
// 2026-04) wrote one session-*.json that is rewritten whole; those are re-read on change, up to a
// size cap. Subagents record to chats/<parent session id>/<agent id>.jsonl.
// The format is undocumented; it was read from github.com/google-gemini/gemini-cli
// (packages/core/src/services/chatRecordingService.ts and chatRecordingTypes.ts, config/storage.ts,
// config/projectRegistry.ts, core/geminiChat.ts, tools/tool-names.ts, tools/mcp-tool.ts).
// Read-only: nothing under ~/.gemini is ever written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SECRET_KEY, Tail, activity, clip, summaryFields, toolLabel } from './parse.js';
import { headLine } from './codex.js';

const ROOT = path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
export const GEMINI_DIR = {
  root: ROOT,
  tmp: path.join(ROOT, 'tmp'),
  registry: path.join(ROOT, 'projects.json'), // { projects: { <project path>: <slug> } }
};
const RECENT_MS = 3 * 3600e3;    // keep ended sessions visible this long
const MAX_RECENT = 10;
const MAX_SUBAGENTS = 20;
const FRESH_MS = 120e3;          // a session written this recently counts as live, process seen or not
const OPEN_MS = 30 * 60e3;       // with a Gemini process running, sessions active this recently count as open
const BUSY_MS = 15 * 60e3;       // a turn with no new record for this long no longer counts as working
const MAX_EVENTS = 400;
const MAX_JSON = 8 * 1024 * 1024; // legacy whole-file sessions bigger than this are not read
const MAX_IDS = 3000;            // message / tool call ids remembered for deduping

const SESSION_RE = /^session-.+\.jsonl?$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/; // ids end up in keys and paths: no '/', no ':', not '.' or '..'
const TERMINAL = new Set(['success', 'error', 'cancelled']);
const INTERRUPTED = '[The previous response was interrupted before it completed.]';

const readdir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const statOf = (f) => { try { return fs.statSync(f); } catch { return null; } };
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const firstLine = (s) => String(s ?? '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
const base = (p) => (p ? path.basename(String(p)) : '');
const time = (s) => (typeof s === 'string' ? Date.parse(s) || 0 : 0);
const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const remember = (map, k, v) => {
  map.set(k, v);
  if (map.size > MAX_IDS) map.delete(map.keys().next().value);
  return v;
};

// A PartListUnion: a string, one Part or an array of both.
const toParts = (c) => (Array.isArray(c) ? c : c == null ? [] : [c]).map((p) => (typeof p === 'string' ? { text: p } : p)).filter(isObj);
// Visible text only: thought parts (thought: true) are never shown.
const textOf = (c) => toParts(c).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();

/* ---------- tools ---------- */

const CATEGORY = {
  read_file: 'read', read_many_files: 'read', list_directory: 'read', glob: 'read', grep_search: 'read',
  search_file_content: 'read', get_internal_docs: 'read', read_mcp_resource: 'read', list_mcp_resources: 'read',
  write_file: 'edit', replace: 'edit', save_memory: 'edit',
  run_shell_command: 'run', list_background_processes: 'run', read_background_output: 'run',
  web_fetch: 'web', google_web_search: 'web',
  invoke_agent: 'agent', complete_task: 'agent',
  write_todos: 'plan', enter_plan_mode: 'plan', exit_plan_mode: 'plan', activate_skill: 'plan', update_topic: 'plan',
  tracker_create_task: 'plan', tracker_update_task: 'plan', tracker_get_task: 'plan', tracker_list_tasks: 'plan',
  tracker_add_dependency: 'plan', tracker_visualize: 'plan',
  ask_user: 'ask',
};
const ASKS = new Set(['ask_user', 'exit_plan_mode']); // waiting for an answer or a plan approval

// MCP tools are mcp_<server>_<tool> (server names have no '_' there); older versions used
// <server>__<tool>. Both become mcp__<server>__<tool> like Claude Code's.
export function geminiToolName(raw) {
  const name = String(raw || 'tool');
  const m = /^mcp_([^_]+)_(.+)$/.exec(name);
  if (m) return `mcp__${m[1]}__${m[2]}`;
  return !name.startsWith('mcp__') && /^[^_].*__./.test(name) ? `mcp__${name}` : name;
}
export const geminiCategory = (name) => (name.startsWith('mcp__') ? 'mcp' : CATEGORY[name] || 'other');

// Arguments can carry secrets (an MCP tool's token, a header): those keys never leave the collector.
const scrub = (v, depth = 0) => {
  if (Array.isArray(v)) return depth > 6 ? [] : v.map((x) => scrub(x, depth + 1));
  if (!isObj(v)) return v;
  return depth > 6 ? {} : Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_KEY.test(k)).map(([k, x]) => [k, scrub(x, depth + 1)]));
};
const fileArg = (a) => a.file_path || a.absolute_path || a.path;
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map(String);
const firstUrl = (s) => /https?:\/\/[^\s"'<>)]+/.exec(String(s ?? ''))?.[0] || '';
const todoStatus = (s) => (s === 'in_progress' || s === 'completed' ? s : 'pending');

// null: no summary of its own (MCP tools, questions, topics…), so summaryFields() takes the first
// text argument and marks it freeText, which a hub only gets at the full level.
function toolSummary(name, a) {
  switch (name) {
    case 'read_file': case 'write_file': case 'replace': return base(fileArg(a));
    case 'list_directory': return base(a.dir_path || a.path) || '.';
    case 'read_many_files': {
      const paths = list(a.include ?? a.paths);
      return paths.length > 1 ? `${base(paths[0])} +${paths.length - 1}` : base(paths[0]);
    }
    case 'glob': return String(a.pattern ?? '');
    case 'grep_search': case 'search_file_content': {
      const dir = a.dir_path || a.path;
      return `"${a.pattern ?? ''}"${dir ? ' in ' + base(dir) : ''}`;
    }
    case 'run_shell_command': return a.description || firstLine(a.command);
    case 'list_background_processes': return 'Background processes';
    case 'read_background_output': return 'Reading output';
    case 'google_web_search': return String(a.query ?? '');
    case 'web_fetch': return host(a.url) || host(firstUrl(a.prompt)); // the prompt itself stays in the detail
    case 'write_todos': return `${list(a.todos).length} todos`;
    case 'save_memory': return 'Saving a memory';
    case 'activate_skill': return String(a.name ?? '');
    case 'get_internal_docs': return base(a.path);
    case 'invoke_agent': return String(a.agent_name || 'Subagent'); // the task itself is a prompt: detail only
    case 'complete_task': return 'Final report';
    case 'enter_plan_mode': return 'Plan mode';
    case 'exit_plan_mode': return 'Plan ready';
  }
  return null;
}

function toolDetail(name, a) {
  switch (name) {
    case 'run_shell_command': return `${a.command ?? ''}${a.dir_path || a.directory ? `\n(in ${a.dir_path || a.directory})` : ''}`;
    case 'replace': return `${fileArg(a)}\n- ${clip(a.old_string, 500)}\n+ ${clip(a.new_string, 500)}`;
    case 'write_file': return `${fileArg(a)}\n${String(a.content ?? '').split('\n').length} lines`;
    case 'read_file': return `${fileArg(a)}${a.start_line || a.offset ? ` (from line ${a.start_line || a.offset})` : ''}`;
    case 'invoke_agent': return String(a.prompt ?? '');
    case 'write_todos':
      return (Array.isArray(a.todos) ? a.todos : []).map((t) =>
        `[${t?.status === 'completed' ? 'x' : t?.status === 'in_progress' ? '~' : ' '}] ${t?.description ?? ''}`).join('\n');
  }
  return JSON.stringify(scrub(a), null, 1);
}

// A tool call's result: functionResponse parts ({ output } or { error }), else its display text.
function resultText(tc) {
  const out = [];
  for (const p of toParts(tc.result)) {
    const r = p.functionResponse?.response;
    if (isObj(r)) {
      const v = r.output ?? r.error ?? r.result;
      if (v != null) out.push(typeof v === 'string' ? v : JSON.stringify(v));
    } else if (typeof p.text === 'string' && !p.thought) out.push(p.text);
    else if (p.inlineData || p.fileData) out.push('[file]');
  }
  if (!out.length && typeof tc.resultDisplay === 'string') out.push(tc.resultDisplay);
  return out.join('\n');
}

/* ---------- one chat ---------- */

// Running state of one Gemini chat, shaped like parse.js's Transcript so activity() works on it.
export class GeminiTranscript {
  constructor() {
    this.events = [];
    this.pending = new Map(); // tool call id -> tool event still waiting for its result
    this.msgs = new Map();    // message id -> { seen, said, out } (messages are re-appended whole)
    this.tools = new Map();   // tool call id -> { done }
    this.agents = new Map();  // subagent id -> { toolId, type, done } from invoke_agent calls
    this.seq = 0;
    this.cur = 'r';
    this.meta = null;
    this.summary = '';
    this.outTokens = 0;
    this.context = 0;
    this.contextAt = 0;
    this.toolCount = 0;
    this.model = '';
    this.lastPrompt = '';
    this.firstPrompt = '';
    this.lastSay = null;
    this.todos = null;
    this.phase = null;
    this.turn = false;     // a prompt is being worked on
    this.turnEnded = false;
    this.completed = false; // a subagent delivered its result (complete_task)
    this.firstAt = 0;
    this.lastAt = 0;
  }

  get hasContent() { return this.msgs.size > 0; }

  setMeta(m) {
    if (!isObj(m)) return;
    // Only what is used: memoryScratchpad (workflow summary, touched paths) and the rest stay unread.
    this.meta = { ...this.meta, ...(typeof m.startTime === 'string' && { startTime: m.startTime }), ...(typeof m.kind === 'string' && { kind: m.kind }) };
    if (typeof m.summary === 'string' && m.summary.trim()) this.summary = clip(m.summary.trim(), 120);
    this.touch(time(m.lastUpdated));
  }

  touch(t) {
    if (!t) return;
    if (!this.firstAt || t < this.firstAt) this.firstAt = t;
    this.lastAt = Math.max(this.lastAt, t);
  }

  // One JSONL record.
  ingest(j) {
    const out = [];
    if (!isObj(j)) return out;
    this.cur = 'r';
    if (typeof j.$rewindTo === 'string') {
      this.endTurn(this.lastAt);
      out.push({ kind: 'note', text: 'Conversation rewound' });
    } else if (isObj(j.$set)) {
      this.setMeta({ ...j.$set, messages: undefined });
      if (Array.isArray(j.$set.messages)) for (const m of j.$set.messages) this.message(m, out); // legacy checkpoint
    } else if (isObj(j.$patch)) {
      this.patch(j.$patch, out);
    } else if (typeof j.id === 'string' && typeof j.type === 'string') {
      this.message(j, out);
    } else if (typeof j.sessionId === 'string') {
      this.setMeta(j); // the first line
    }
    return this.finish(out);
  }

  // A legacy session-*.json: the whole conversation in one object, re-read on every change.
  ingestRecord(rec) {
    const out = [];
    if (!isObj(rec)) return out;
    this.setMeta({ ...rec, messages: undefined });
    for (const m of Array.isArray(rec.messages) ? rec.messages : []) this.message(m, out);
    return this.finish(out);
  }

  finish(out) {
    for (const e of out) {
      e.id = `${this.cur}:${this.seq++}`;
      e.t = e.t || this.lastAt || Date.now();
      this.events.push(e);
    }
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return out;
  }

  message(m, out) {
    if (!isObj(m) || typeof m.id !== 'string') return;
    const t = time(m.timestamp);
    const mid = SAFE_ID.test(m.id) ? m.id.slice(0, 40) : 'm';
    this.cur = mid;
    this.touch(t);
    const st = this.msgs.get(m.id) || remember(this.msgs, m.id, { seen: false, said: false, out: 0 });
    const first = !st.seen;
    st.seen = true;

    switch (m.type) {
      case 'user': {
        if (!first) {
          // Seen before (a legacy file read again): only the state it leaves matters.
          this.turn = true;
          this.turnEnded = false;
          return;
        }
        const parts = toParts(m.content);
        const responses = parts.filter((p) => isObj(p.functionResponse));
        if (responses.length) {
          // Tool results going back to the model: it is working on them.
          for (const p of responses) {
            const id = String(p.functionResponse.id ?? '');
            if (this.pending.has(id)) this.finishTool(id, !isObj(p.functionResponse.response) || p.functionResponse.response.error == null, resultText({ result: [p] }), t, out);
          }
          this.turn = true;
          this.phase = { kind: 'thinking', t };
          return;
        }
        // displayContent is what was typed when it differs from what was sent (@file expansions).
        const text = textOf(m.displayContent) || textOf(m.content);
        if (!text || text.startsWith('<')) return; // injected session / hook context
        this.lastPrompt = clip(text, 300);
        if (!this.firstPrompt) this.firstPrompt = clip(text, 60);
        this.pending.clear();
        this.turn = true;
        this.turnEnded = false;
        this.phase = { kind: 'prompt', t };
        out.push({ kind: 'prompt', text: clip(text, 1500), t });
        return;
      }
      case 'gemini': {
        if (typeof m.model === 'string' && m.model) this.model = m.model;
        const tk = m.tokens;
        if (isObj(tk)) {
          // Output includes thinking tokens, like Claude Code's and Codex's counts.
          const o = (Number(tk.output) || 0) + (Number(tk.thoughts) || 0);
          if (o > st.out) { this.outTokens += o - st.out; st.out = o; }
          if (t >= this.contextAt) { this.context = (Number(tk.input) || 0) + (Number(tk.output) || 0); this.contextAt = t; }
        }
        const text = textOf(m.content);
        if (text && !st.said) {
          st.said = true;
          if (text === INTERRUPTED) out.push({ kind: 'note', text: 'Response interrupted', t });
          else {
            out.push({ kind: 'say', text: clip(text, 2500), t });
            this.lastSay = { text: clip(text, 400), t };
            this.phase = { kind: 'writing', t };
          }
        }
        const calls = (Array.isArray(m.toolCalls) ? m.toolCalls : []).filter(isObj);
        for (const tc of calls) this.toolCall(tc, t, out);
        if (!calls.length) {
          // A reply with no tool calls ends the turn (the model is only called again for tool results).
          if (text) this.endTurn(t);
        } else if (calls.every((tc) => TERMINAL.has(tc.status)) && calls.some((tc) => tc.status === 'cancelled')) {
          this.endTurn(t); // cancelled by the user: nothing goes back to the model
        } else {
          this.turn = true;
        }
        return;
      }
      case 'error': case 'warning': {
        if (!first) return;
        const text = textOf(m.content);
        if (text) out.push({ kind: 'note', text: clip(text, 300), t });
        if (m.type === 'error') this.endTurn(t);
      }
      // 'info' messages carry injected file data: nothing to show
    }
  }

  toolCall(tc, mt, out) {
    const id = String(tc.id ?? '');
    if (!id) return;
    const t = time(tc.timestamp) || mt;
    this.touch(t);
    const name = geminiToolName(tc.name);
    const args = isObj(tc.args) ? tc.args : {};
    let st = this.tools.get(id);
    if (!st) {
      st = remember(this.tools, id, { done: false, p: null });
      const cat = geminiCategory(name);
      const e = {
        kind: 'tool', toolId: id, name, label: toolLabel(name), cat,
        ...summaryFields(toolSummary(name, args), scrub(args)), detail: clip(toolDetail(name, args), 1500), t,
      };
      st.p = { ...e, t };
      this.pending.set(id, st.p);
      this.toolCount++;
      if (name === 'write_todos' && Array.isArray(args.todos)) {
        this.todos = args.todos.filter((x) => isObj(x) && x.status !== 'cancelled')
          .map((x) => ({ content: clip(x.description, 200), status: todoStatus(x.status) }));
      }
      out.push(e);
      this.phase = { kind: 'tool', t };
    } else if (!st.done && !TERMINAL.has(tc.status) && st.p && !this.pending.has(id)) {
      this.pending.set(id, st.p); // a re-read legacy file ended an earlier turn on the way here
    }
    if (!TERMINAL.has(tc.status)) { this.turn = true; this.turnEnded = false; }
    if (name === 'invoke_agent' && typeof tc.agentId === 'string' && SAFE_ID.test(tc.agentId)) {
      remember(this.agents, tc.agentId, { toolId: id, type: clip(args.agent_name || 'subagent', 80), done: TERMINAL.has(tc.status) });
    }
    if (!st.done && TERMINAL.has(tc.status)) {
      if (name === 'complete_task' && tc.status === 'success') this.completed = true;
      this.finishTool(id, tc.status === 'success', resultText(tc), t, out);
    }
  }

  finishTool(id, ok, text, t, out) {
    const st = this.tools.get(id);
    if (st) st.done = true;
    const p = this.pending.get(id);
    this.pending.delete(id);
    const ms = p && t && t >= p.t ? t - p.t : null;
    out.push({ kind: 'result', toolId: id, ok, text: clip(String(text).trim(), 900), ms, t });
    this.phase = { kind: 'result', t };
  }

  // { $patch }: history rewrites. Only tool results that arrive this way are used.
  patch(p, out) {
    const patches = [...(typeof p.id === 'string' ? [p] : []), ...(Array.isArray(p.updates) ? p.updates : [])];
    for (const x of patches) {
      for (const tcp of Array.isArray(x?.toolCalls) ? x.toolCalls : []) {
        const id = String(tcp?.id ?? '');
        if (!this.pending.has(id) || tcp.result == null) continue;
        const r = toParts(tcp.result).find((q) => isObj(q.functionResponse))?.functionResponse?.response;
        this.finishTool(id, !isObj(r) || r.error == null, resultText(tcp), this.lastAt, out);
      }
    }
  }

  endTurn(t) {
    this.turn = false;
    this.turnEnded = true;
    this.pending.clear();
    this.phase = { kind: 'done', t };
  }
}

/* ---------- collector ---------- */

function chatReader(file) {
  if (file.endsWith('.json')) return { legacy: true, mtime: 0, read() {
    const st = statOf(file);
    if (!st || st.mtimeMs === this.mtime || st.size > MAX_JSON) return null;
    this.mtime = st.mtimeMs;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    return parseJson(text); // null while Gemini is halfway through a rewrite: retried on the next change
  } };
  return new Tail(file, 1536 * 1024);
}

export class GeminiCollector extends EventEmitter {
  sessions = new Map(); // session id -> session record
  byFile = new Map();   // chat file -> id of the session it holds
  rejected = new Set(); // chat files that aren't main sessions (subagent kind, unusable id)
  seen = new Set();     // chat files scanNew() has looked at
  projects = new Map(); // project folder under tmp/ -> project path
  ticks = 0;

  // running(): whether a Gemini CLI process is seen on this machine (ProcessScanner). Gemini keeps no
  // lock or pid file per session, so that and how recently a chat was written decide what is live.
  constructor({ running = () => false, dir = GEMINI_DIR } = {}) {
    super();
    this.running = running;
    this.dir = dir;
  }

  start() {
    this.scanRecent();
    this.tick();
    setInterval(() => this.tick(), 1000);
    setInterval(() => this.scanRecent(), 15000);
  }

  tick() {
    try {
      if (this.ticks % 3 === 0) this.scanNew();
      for (const s of this.sessions.values()) if (s.live || this.ticks % 5 === 0) this.pump(s);
      this.setLive();
    } catch (e) {
      console.error('[gemini] tick failed:', e);
    }
    this.ticks++;
    this.emit('tick');
  }

  // Chats written in the last hours, across every project folder.
  candidates() {
    const now = Date.now();
    const found = [];
    for (const d of readdir(this.dir.tmp)) {
      const chats = path.join(this.dir.tmp, d, 'chats');
      const names = readdir(chats);
      for (const f of names) {
        if (!SESSION_RE.test(f)) continue;
        if (f.endsWith('.json') && names.includes(`${f}l`)) continue; // migrated to JSONL on resume
        const file = path.join(chats, f);
        const st = statOf(file);
        if (st?.isFile() && now - st.mtimeMs < RECENT_MS) found.push({ project: d, file, mtime: st.mtimeMs });
      }
    }
    return found.sort((a, b) => b.mtime - a.mtime);
  }

  scanRecent() {
    const now = Date.now();
    const keep = new Set();
    for (const x of this.candidates()) {
      if (keep.size >= MAX_RECENT) break;
      const id = this.byFile.get(x.file) || (this.rejected.has(x.file) ? null : this.add(x));
      if (id) keep.add(id);
    }
    for (const [id, s] of this.sessions) {
      if (!s.live && !keep.has(id) && now - (s.endedAt || s.tr.lastAt || 0) > RECENT_MS) {
        this.sessions.delete(id);
        this.byFile.delete(s.file);
      }
    }
    if (this.rejected.size > 5000) this.rejected.clear();
    if (this.seen.size > 20000) this.seen.clear();
  }

  // Chats started since the last full scan: file names only, each new name is looked at once.
  scanNew() {
    const now = Date.now();
    for (const d of readdir(this.dir.tmp)) {
      const chats = path.join(this.dir.tmp, d, 'chats');
      const names = readdir(chats);
      for (const f of names) {
        const file = path.join(chats, f);
        if (!SESSION_RE.test(f) || this.seen.has(file) || this.byFile.has(file) || this.rejected.has(file)) continue;
        this.seen.add(file);
        if (f.endsWith('.json') && names.includes(`${f}l`)) continue;
        const st = statOf(file);
        if (st?.isFile() && now - st.mtimeMs < RECENT_MS) this.add({ project: d, file, mtime: st.mtimeMs });
      }
    }
  }

  add({ project, file, mtime }) {
    const reader = chatReader(file);
    let id = null;
    let first = null;
    if (reader.legacy) {
      first = reader.read();
      reader.mtime = 0; // read again by pump()
      id = first?.sessionId;
    } else {
      first = headLine(file);
      if (!first) return null; // no metadata line yet: tried again on the next scan
      id = first.sessionId;
    }
    if (typeof id !== 'string' || !SAFE_ID.test(id) || first?.kind === 'subagent') {
      this.rejected.add(file);
      return null;
    }
    const old = this.sessions.get(id);
    if (old && old.file !== file) {
      if ((statOf(old.file)?.mtimeMs || 0) >= mtime) { this.rejected.add(file); return id; }
      this.byFile.delete(old.file);
    }
    const tr = new GeminiTranscript();
    if (!reader.legacy) tr.setMeta(first);
    const s = { id, file, project, reader, tr, live: false, endedAt: 0, mtime, subs: new Map(), subsAt: 0, cwd: this.projectPath(project) };
    this.sessions.set(id, s);
    this.byFile.set(file, id);
    this.pump(s);
    return id;
  }

  // The project's path: tmp/<slug>/.project_root, else the projects.json entry for the slug.
  // (Old sha256-named folders have neither; they are renamed to slugs by newer versions.)
  projectPath(d) {
    if (this.projects.has(d)) return this.projects.get(d);
    let p = '';
    try { p = fs.readFileSync(path.join(this.dir.tmp, d, '.project_root'), 'utf8').trim(); } catch { /* none */ }
    if (!p) {
      try {
        const reg = JSON.parse(fs.readFileSync(this.dir.registry, 'utf8'))?.projects;
        p = Object.entries(isObj(reg) ? reg : {}).find(([, slug]) => slug === d)?.[0] || '';
      } catch { /* none */ }
    }
    // Gemini lowercases the path on Windows; the folder itself has the real case.
    if (p) { try { p = fs.realpathSync.native(p); } catch { /* moved or deleted */ } }
    this.projects.set(d, p);
    return p;
  }

  read(reader, tr) {
    if (reader.legacy) {
      const rec = reader.read();
      return rec ? tr.ingestRecord(rec) : [];
    }
    return reader.read().flatMap((r) => tr.ingest(r));
  }

  pump(s) {
    const st = statOf(s.file);
    if (!st) {
      // Gemini deletes a chat that never got a prompt when it exits; a deleted chat is gone.
      this.sessions.delete(s.id);
      this.byFile.delete(s.file);
      return;
    }
    s.mtime = st.mtimeMs;
    const events = this.read(s.reader, s.tr);
    if (events.length) this.emit('events', `gemini:${s.id}`, events);
    if (Date.now() - s.subsAt > 5000) this.scanSubs(s);
    for (const sub of s.subs.values()) {
      const evs = this.read(sub.reader, sub.tr);
      if (evs.length) this.emit('events', `gemini:${s.id}/${sub.id}`, evs);
    }
  }

  // Subagents of a session: chats/<session id>/<agent id>.jsonl.
  scanSubs(s) {
    s.subsAt = Date.now();
    const dir = path.join(path.dirname(s.file), s.id);
    const files = readdir(dir).filter((f) => f.endsWith('.jsonl') && SAFE_ID.test(f.slice(0, -6)))
      .map((f) => ({ id: f.slice(0, -6), file: path.join(dir, f), mtime: statOf(path.join(dir, f))?.mtimeMs || 0 }))
      .sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SUBAGENTS);
    for (const f of files) {
      if (!s.subs.has(f.id)) s.subs.set(f.id, { id: f.id, file: f.file, reader: new Tail(f.file, 512 * 1024), tr: new GeminiTranscript(), mtime: f.mtime });
      else s.subs.get(f.id).mtime = f.mtime;
    }
    const ids = new Set(files.map((f) => f.id));
    for (const id of s.subs.keys()) if (!ids.has(id)) s.subs.delete(id);
  }

  lastAt(s) { return s.tr.lastAt || s.mtime || 0; }

  setLive() {
    const now = Date.now();
    const up = this.running();
    // With Gemini running, its most recently active chat is taken to be the open one, however long
    // it has been idle; other chats only count as open while recently active. A chat with no
    // prompt yet counts here too: Gemini starts one on launch, so an older chat is not the open one.
    let newest = null;
    for (const s of this.sessions.values()) if (!newest || this.lastAt(s) > this.lastAt(newest)) newest = s;
    for (const s of this.sessions.values()) {
      const age = now - this.lastAt(s);
      const was = s.live;
      s.live = s.tr.hasContent && (age < FRESH_MS || (up && (s === newest || age < OPEN_MS)));
      if (was && !s.live) s.endedAt = now;
    }
  }

  hasLive() { return [...this.sessions.values()].some((s) => s.live); }

  shown() { return [...this.sessions.values()].filter((s) => s.tr.hasContent); }

  allEvents(limit) {
    const out = {};
    for (const s of this.shown()) {
      out[`gemini:${s.id}`] = s.tr.events.slice(-limit);
      for (const sub of s.subs.values()) out[`gemini:${s.id}/${sub.id}`] = sub.tr.events.slice(-limit);
    }
    return out;
  }

  snapshot() { return this.shown().map((s) => this.summarize(s)); }

  status(s) {
    const { tr } = s;
    if (!s.live) return 'offline';
    if (!tr.turn || Date.now() - this.lastAt(s) > BUSY_MS) return 'idle';
    const p = [...tr.pending.values()].at(-1);
    return p && ASKS.has(p.name) ? 'waiting' : 'working';
  }

  summarize(s) {
    const { tr } = s;
    const m = tr.meta || {};
    const status = this.status(s);
    const cwd = s.cwd || '';
    // Gemini has no user-set session names: its summary is written by the model from the
    // conversation, so like a name made from the first prompt it is marked nameFromPrompt.
    const fromChat = tr.summary || tr.firstPrompt;
    return {
      key: `gemini:${s.id}`,
      sessionId: s.id,
      pid: null,
      live: s.live,
      kind: 'gemini',
      canMessage: false,
      name: fromChat || path.basename(cwd) || s.id.slice(0, 8),
      nameFromPrompt: !!fromChat,
      title: '',
      project: path.basename(cwd),
      cwd,
      branch: '',
      model: tr.model,
      version: '',
      status,
      rawStatus: tr.turn ? 'turn' : '',
      now: activity(tr, status, {
        since: tr.phase?.t || tr.lastAt,
        detail: status === 'waiting' ? [...tr.pending.values()].at(-1)?.summary : undefined,
      }),
      lastSay: tr.lastSay,
      lastPrompt: tr.lastPrompt,
      prs: [],
      todos: tr.todos,
      outTokens: tr.outTokens,
      cost: null,
      context: tr.context,
      toolCount: tr.toolCount,
      startedAt: time(m.startTime) || tr.firstAt,
      lastAt: this.lastAt(s),
      job: null,
      subagents: [...s.subs.values()]
        .filter((sub) => sub.tr.hasContent)
        .sort((a, b) => b.mtime - a.mtime)
        .map((sub) => {
          const link = tr.agents.get(sub.id);
          const st = sub.tr.completed || link?.done ? 'done'
            : sub.tr.turn && s.live && Date.now() - (sub.tr.lastAt || sub.mtime) < BUSY_MS ? 'working' : 'idle';
          return {
            key: `gemini:${s.id}/${sub.id}`,
            agentId: sub.id,
            type: link?.type || 'subagent',
            description: '',
            toolUseId: link?.toolId || null,
            status: st,
            now: activity(sub.tr, st),
            model: sub.tr.model,
            outTokens: sub.tr.outTokens,
            cost: null,
            context: sub.tr.context,
            toolCount: sub.tr.toolCount,
            startedAt: time(sub.tr.meta?.startTime) || sub.tr.firstAt,
            lastAt: sub.tr.lastAt || sub.mtime,
          };
        }),
    };
  }
}
