// Watches OpenAI Codex CLI's local sessions ($CODEX_HOME, default ~/.codex): the rollout JSONL files
// under sessions/YYYY/MM/DD/ and the writer locks a running Codex holds for each open thread.
// The rollout format is undocumented; it was read from github.com/openai/codex (codex-rs: rollout,
// protocol/src/protocol.rs and models.rs). Read-only: nothing under $CODEX_HOME is ever written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Tail, activity, clip, summaryFields, toolLabel } from './parse.js';

const ROOT = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const CODEX_DIR = {
  root: ROOT,
  sessions: path.join(ROOT, 'sessions'),
  locks: path.join(ROOT, 'thread-writer-locks'),
  index: path.join(ROOT, 'session_index.jsonl'),
};
const RECENT_MS = 3 * 3600e3;   // keep ended sessions visible this long
const MAX_RECENT = 10;
const LIVE_MTIME_MS = 120e3;    // a lock with no Codex process counts as live only this long after the last write
const MAX_EVENTS = 400;
const MAX_HEAD = 4 * 1024 * 1024; // session_meta is the first line and carries the whole system prompt

// rollout-2026-11-27T09-15-02-<uuid>.jsonl, or …-<uuid>_<rolloutId>.jsonl for a reverted thread.
const FILE_RE = /^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[^.]+)?\.jsonl$/i;

const readdir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };
const firstLine = (s) => String(s ?? '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
const base = (p) => (p ? path.basename(String(p)) : '');
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

// The first line of a file, read from the start (a Tail that starts near the end may skip it).
export function headLine(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const chunks = [];
    const buf = Buffer.alloc(64 * 1024);
    for (let pos = 0; pos < MAX_HEAD;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl < 0 ? n : nl)));
      if (nl >= 0) return parseJson(Buffer.concat(chunks).toString('utf8'));
      pos += n;
    }
    return null; // no complete first line yet
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------- tools ---------- */

const CATEGORY = {
  exec_command: 'run', write_stdin: 'run', shell: 'run', shell_command: 'run', local_shell: 'run', exec: 'run', wait: 'run',
  apply_patch: 'edit',
  view_image: 'read', tool_search: 'read',
  web_search: 'web',
  update_plan: 'plan',
  spawn_agent: 'agent', send_input: 'agent', send_message: 'agent', followup_task: 'agent', resume_agent: 'agent',
  wait_agent: 'agent', close_agent: 'agent', list_agents: 'agent', interrupt_agent: 'agent',
  request_user_input: 'ask', request_permissions: 'ask',
};
const ASKS = new Set(['request_user_input', 'request_permissions']);
export const codexCategory = (name) => (name.startsWith('mcp__') ? 'mcp' : CATEGORY[name] || 'other');

// A tool's full name: MCP tools carry their server in `namespace` ("mcp__server__" + "tool").
const fullName = (p) => {
  const ns = typeof p.namespace === 'string' ? p.namespace : '';
  const name = String(p.name || 'tool');
  return ns && ns !== 'functions' ? (ns.endsWith('_') ? ns + name : `${ns}__${name}`) : name;
};

// shell: ["bash", "-lc", "npm test"] -> "npm test"
const shellText = (cmd) => {
  if (!Array.isArray(cmd)) return String(cmd ?? '');
  const i = cmd.findIndex((x) => x === '-lc' || x === '-c' || x === '/c' || x === '-Command');
  return (i >= 0 && cmd[i + 1] ? cmd.slice(i + 1) : cmd).join(' ');
};
const patchFiles = (patch) => [...String(patch).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
const planLines = (plan) => (Array.isArray(plan) ? plan : []).map((s) =>
  `[${s.status === 'completed' ? 'x' : s.status === 'in_progress' ? '~' : ' '}] ${s.step}`).join('\n');

function toolSummary(name, args, input) {
  switch (name) {
    case 'exec_command': return firstLine(args.cmd);
    case 'shell': case 'shell_command': case 'local_shell': return firstLine(shellText(args.command));
    case 'write_stdin': return args.chars ? 'Sending input' : 'Reading output'; // typed input can be a password
    case 'apply_patch': {
      const files = patchFiles(input);
      return files.length > 2 ? `${base(files[0])} +${files.length - 1} files` : files.map(base).join(', ');
    }
    case 'view_image': return base(args.path);
    case 'update_plan': return `${(args.plan || []).length} steps`;
    case 'spawn_agent': return args.agent_type || 'Subagent'; // the task itself is a prompt: detail only
    case 'web_search': return args.query;
  }
  // Other tools (MCP, messages to subagents, questions, freeform tools) get their first text
  // argument, marked freeText so a hub only gets it at the full level (summaryFields in parse.js).
  return null;
}

function toolDetail(name, args, input) {
  switch (name) {
    case 'exec_command': return `${args.cmd ?? ''}${args.workdir ? `\n(in ${args.workdir})` : ''}`;
    case 'shell': case 'shell_command': case 'local_shell':
      return `${shellText(args.command)}${args.workdir ? `\n(in ${args.workdir})` : ''}`;
    case 'update_plan': return [args.explanation, planLines(args.plan)].filter(Boolean).join('\n');
  }
  if (input != null) return String(input);
  return JSON.stringify(args, null, 1);
}

// Exec output starts with a header ("Wall time: …", "Process exited with code 1", "Output:").
function outputText(output) {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return output && typeof output === 'object' ? outputText(output.content ?? output.output) : '';
  return output.map((c) => (typeof c?.text === 'string' ? c.text : c?.type === 'input_image' ? '[image]' : '')).filter(Boolean).join('\n');
}
function parseOutput(output) {
  const text = outputText(output);
  const code = /^(?:Process exited with code|Exit code:) (-?\d+)$/m.exec(text.slice(0, 2000))?.[1];
  const body = /^Output:\r?\n/m.exec(text.slice(0, 2000));
  const ok = code != null ? Number(code) === 0 : !/^(apply_patch verification failed|Error:|error:)/i.test(text.trim());
  return { ok, text: body ? text.slice(body.index + body[0].length) : text };
}

const isInjected = (text) => text.startsWith('<') || text.startsWith('# AGENTS.md instructions');
const userText = (content) => (Array.isArray(content) ? content : [])
  .map((c) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n');

/* ---------- one rollout ---------- */

// Running state of one Codex thread, shaped like parse.js's Transcript so activity() works on it.
export class CodexTranscript {
  constructor() {
    this.events = [];
    this.pending = new Map(); // call_id -> tool event still waiting for its output
    this.seq = 0;
    this.meta = null;
    this.outTokens = 0;
    this.context = 0;
    this.contextWindow = 0;
    this.toolCount = 0;
    this.model = '';
    this.effort = '';
    this.cwd = '';
    this.branch = '';
    this.lastPrompt = '';
    this.firstPrompt = '';
    this.lastSay = null;
    this.todos = null;
    this.phase = null;
    this.turn = null;  // id of the open turn (task_started without task_complete / turn_aborted)
    this.turnEnded = false;
    this.firstAt = 0;
    this.lastAt = 0;
  }

  setMeta(m) {
    if (!m || typeof m !== 'object') return;
    this.meta = m;
    if (m.cwd && !this.cwd) this.cwd = String(m.cwd);
    if (m.git?.branch && !this.branch) this.branch = String(m.git.branch);
  }

  ingest(j) {
    const out = [];
    const t = j?.timestamp ? Date.parse(j.timestamp) || 0 : 0;
    const p = j?.payload;
    if (!p || typeof p !== 'object') return out;
    // A subagent's file starts with a copy of its parent's history.
    const skipBelow = this.meta?.subagent_history_start_ordinal;
    if (typeof skipBelow === 'number' && typeof j.ordinal === 'number' && j.ordinal < skipBelow && j.type !== 'session_meta') return out;

    switch (j.type) {
      case 'session_meta': this.setMeta(p); break;
      case 'turn_context':
        if (p.cwd) this.cwd = String(p.cwd);
        if (p.model) this.model = String(p.model);
        if (p.effort) this.effort = String(p.effort);
        break;
      case 'compacted': out.push({ kind: 'note', text: 'Context compacted' }); break;
      case 'response_item': this.item(p, t, out); break;
      case 'event_msg': this.event(p, t, out); break;
    }

    if (t && (j.type === 'response_item' || j.type === 'event_msg')) {
      if (!this.firstAt) this.firstAt = t;
      this.lastAt = Math.max(this.lastAt, t);
    }
    for (const e of out) {
      e.id = `${j.ordinal ?? 'r'}:${this.seq++}`;
      e.t = e.t || t || Date.now();
      this.events.push(e);
    }
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return out;
  }

  item(p, t, out) {
    switch (p.type) {
      case 'message': {
        // User text comes from the user_message / UserMessage events, which hold only what was typed.
        if (p.role !== 'assistant') return;
        const text = userText(p.content).trim();
        if (!text) return;
        out.push({ kind: 'say', text: clip(text, 2500) });
        this.lastSay = { text: clip(text, 400), t };
        this.phase = { kind: 'writing', t };
        return;
      }
      case 'reasoning': this.phase = { kind: 'thinking', t }; return; // never shown: summaries stay private too
      case 'function_call': {
        const args = parseJson(p.arguments) || {};
        this.tool(p.call_id, fullName(p), args, undefined, t, out);
        return;
      }
      case 'custom_tool_call': this.tool(p.call_id, fullName(p), {}, String(p.input ?? ''), t, out); return;
      case 'local_shell_call': {
        const a = p.action || {};
        this.tool(p.call_id || p.id, 'local_shell', { command: a.command, workdir: a.working_directory }, undefined, t, out);
        return;
      }
      case 'web_search_call': {
        const a = p.action || {};
        const what = a.query || a.queries?.[0] || a.url || a.pattern || 'Search';
        const id = p.id || `ws-${this.seq}`;
        this.tool(id, 'web_search', { query: String(what) }, undefined, t, out);
        if (p.status !== 'in_progress') this.result(id, true, '', t, out);
        return;
      }
      case 'function_call_output': case 'custom_tool_call_output': {
        const r = parseOutput(p.output);
        this.result(p.call_id, r.ok, r.text, t, out);
      }
    }
  }

  tool(id, name, args, input, t, out) {
    if (!id) id = `call-${this.seq}`;
    const cat = codexCategory(name);
    const e = {
      kind: 'tool', toolId: String(id), name, label: toolLabel(name), cat,
      ...summaryFields(toolSummary(name, args, input), input ?? args), detail: clip(toolDetail(name, args, input), 1500),
    };
    this.pending.set(e.toolId, { ...e, t });
    this.toolCount++;
    if (name === 'update_plan' && Array.isArray(args.plan)) {
      this.todos = args.plan.map((s) => ({ content: clip(s.step, 200), status: s.status }));
    }
    out.push(e);
    this.phase = { kind: 'tool', t };
  }

  result(id, ok, text, t, out) {
    id = String(id ?? '');
    const p = this.pending.get(id);
    this.pending.delete(id);
    out.push({ kind: 'result', toolId: id, ok, text: clip(String(text).trim(), 900), ms: p && t ? t - p.t : null });
    this.phase = { kind: 'result', t };
  }

  prompt(text, t, out) {
    text = String(text ?? '').trim();
    if (!text || isInjected(text)) return;
    this.lastPrompt = clip(text, 300);
    if (!this.firstPrompt) this.firstPrompt = clip(text, 60);
    this.phase = { kind: 'prompt', t };
    out.push({ kind: 'prompt', text: clip(text, 1500) });
  }

  event(p, t, out) {
    switch (p.type) {
      case 'task_started': case 'turn_started':
        this.turn = p.turn_id || 'turn';
        this.turnEnded = false;
        if (p.model_context_window) this.contextWindow = Number(p.model_context_window) || 0;
        this.phase = { kind: 'thinking', t };
        return;
      case 'task_complete': case 'turn_complete':
        this.endTurn(t);
        if (p.error?.message) out.push({ kind: 'note', text: clip(p.error.message, 300) });
        return;
      case 'turn_aborted':
        this.endTurn(t);
        out.push({ kind: 'note', text: p.reason === 'interrupted' ? 'Interrupted by user' : `Turn ended (${clip(p.reason || 'aborted', 40)})` });
        return;
      case 'token_count': {
        const i = p.info;
        if (!i) return;
        if (i.total_token_usage) this.outTokens = Number(i.total_token_usage.output_tokens) || this.outTokens;
        if (i.last_token_usage) this.context = Number(i.last_token_usage.total_tokens) || this.context;
        if (i.model_context_window) this.contextWindow = Number(i.model_context_window) || this.contextWindow;
        return;
      }
      case 'user_message': this.prompt(p.message, t, out); return; // legacy rollouts
      case 'item_completed':                                       // paginated rollouts
        if (p.item?.type === 'UserMessage') this.prompt(userText(p.item.content), t, out);
    }
  }

  endTurn(t) {
    this.turn = null;
    this.turnEnded = true;
    this.pending.clear();
    this.phase = { kind: 'done', t };
  }
}

/* ---------- collector ---------- */

// Internal threads Codex starts for itself (reviews, compaction, memory) aren't agents to show.
function isInternal(m) {
  const src = m?.source;
  if (src && typeof src === 'object') {
    if (src.internal) return true;
    if (typeof src.subagent === 'string') return true; // review, compact, memory_consolidation
  }
  return ['guardian_review', 'memory_consolidation'].includes(m?.thread_source);
}
const parentOf = (m) => m?.parent_thread_id || m?.source?.subagent?.thread_spawn?.parent_thread_id || null;
const rootOf = (m) => (m?.session_id && m.session_id !== m.id ? m.session_id : parentOf(m));

export class CodexCollector extends EventEmitter {
  threads = new Map(); // threadId -> thread record
  files = new Map();   // threadId -> rollout file, from the last full scan of the sessions tree
  names = new Map();   // threadId -> name set by the user (session_index.jsonl)
  locked = new Set();
  ignored = new Set(); // internal threads (reviews, compaction, memory)
  ticks = 0;
  indexAt = 0;
  indexMtime = 0;

  // running(): whether a Codex process is seen on this machine (ProcessScanner), to tell a lock
  // left behind by a crash from an idle session.
  constructor({ running = () => false, dir = CODEX_DIR } = {}) {
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
      if (this.ticks % 2 === 0) this.scanLocks();
      for (const th of this.threads.values()) if (th.live || this.ticks % 5 === 0) this.pump(th);
    } catch (e) {
      console.error('[codex] tick failed:', e);
    }
    this.ticks++;
    this.emit('tick');
  }

  // Threads a running Codex is writing right now hold thread-writer-locks/<id>.lock.
  scanLocks() {
    this.locked = new Set(readdir(this.dir.locks).filter((f) => f.endsWith('.lock')).map((f) => f.slice(0, -5).toLowerCase()));
    const missing = [...this.locked].filter((id) => !this.threads.has(id) && !this.ignored.has(id));
    // A resumed session keeps writing to its old file, in an old date folder.
    if (missing.length && (missing.some((id) => !this.files.has(id)) && Date.now() - this.indexAt > 10e3)) this.indexFiles();
    for (const id of missing) {
      const f = this.files.get(id);
      if (f) this.add(id, f);
    }
    for (const th of this.threads.values()) this.setLive(th);
  }

  setLive(th) {
    const was = th.live;
    th.live = this.locked.has(th.id) && (this.running() || Date.now() - mtimeOf(th.file) < LIVE_MTIME_MS);
    if (was && !th.live) th.endedAt = Date.now();
  }

  // Every rollout file by thread id (names only, no stat), for finding resumed sessions.
  indexFiles() {
    this.indexAt = Date.now();
    const files = new Map();
    for (const y of readdir(this.dir.sessions)) {
      for (const m of readdir(path.join(this.dir.sessions, y))) {
        for (const d of readdir(path.join(this.dir.sessions, y, m))) {
          const dir = path.join(this.dir.sessions, y, m, d);
          for (const f of readdir(dir)) {
            const id = FILE_RE.exec(f)?.[1]?.toLowerCase();
            if (id) files.set(id, path.join(dir, f)); // a reverted thread's newer file sorts after the original
          }
        }
      }
    }
    this.files = files;
  }

  // Rollouts written to in the last hours. New sessions land in the folder of their (local) start
  // date, so the newest few date folders are enough; resumed sessions in older folders are found
  // through their writer lock instead (scanLocks).
  scanRecent() {
    const now = Date.now();
    const found = [];
    const years = readdir(this.dir.sessions).sort().slice(-2);
    for (const y of years) {
      for (const m of readdir(path.join(this.dir.sessions, y)).sort().slice(-2)) {
        for (const d of readdir(path.join(this.dir.sessions, y, m)).sort().slice(-3)) {
          const dir = path.join(this.dir.sessions, y, m, d);
          for (const f of readdir(dir)) {
            const id = FILE_RE.exec(f)?.[1]?.toLowerCase();
            if (!id) continue;
            const file = path.join(dir, f);
            const mtime = mtimeOf(file);
            if (now - mtime < RECENT_MS) found.push({ id, file, mtime });
          }
        }
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    const keep = new Set();
    for (const x of found) {
      if (keep.size >= MAX_RECENT) break;
      keep.add(x.id);
      if (!this.threads.has(x.id)) this.add(x.id, x.file);
    }
    for (const [id, th] of this.threads) {
      if (!th.live && !keep.has(id) && !this.locked.has(id) && now - (th.endedAt || th.tail.mtime || 0) > RECENT_MS) this.threads.delete(id);
    }
    this.readNames();
  }

  add(id, file) {
    const meta = headLine(file);
    if (meta && meta.type !== 'session_meta') return;
    if (isInternal(meta?.payload)) {
      this.ignored.add(id);
      return;
    }
    const tr = new CodexTranscript();
    tr.setMeta(meta?.payload);
    const th = { id, file, tail: new Tail(file, 1536 * 1024), tr, live: false, endedAt: 0, parent: rootOf(meta?.payload), headTried: meta ? 0 : sizeOf(file) };
    this.threads.set(id, th);
    this.setLive(th);
    this.pump(th);
  }

  pump(th) {
    // Codex writes the first line once the user sends a prompt; read it from the head when it appears
    // (again only once the file has grown, since the line can be megabytes long).
    const size = th.tr.meta ? 0 : sizeOf(th.file);
    if (!th.tr.meta && size !== th.headTried) {
      th.headTried = size;
      const meta = headLine(th.file);
      if (meta?.type === 'session_meta') {
        if (isInternal(meta.payload)) { this.threads.delete(th.id); this.ignored.add(th.id); return; }
        th.tr.setMeta(meta.payload);
        th.parent = rootOf(meta.payload);
      }
    }
    const records = th.tail.read();
    if (!records.length) return;
    const events = [];
    for (const r of records) events.push(...th.tr.ingest(r));
    if (events.length) this.emit('events', this.keyOf(th), events);
  }

  // Thread names the user set in Codex; the last entry for an id wins.
  readNames() {
    const m = mtimeOf(this.dir.index);
    if (!m || m === this.indexMtime) return;
    this.indexMtime = m;
    let text;
    try { text = fs.readFileSync(this.dir.index, 'utf8'); } catch { return; }
    const names = new Map();
    for (const line of text.split('\n')) {
      const j = line.trim() && parseJson(line);
      if (j?.id && typeof j.thread_name === 'string') names.set(String(j.id).toLowerCase(), j.thread_name);
    }
    this.names = names;
  }

  // A subagent hangs under its root thread when that one is shown, like Claude Code's subagents.
  rootThread(th) {
    const p = th.parent && this.threads.get(String(th.parent).toLowerCase());
    return p && !p.parent ? p : null;
  }

  keyOf(th) {
    const root = this.rootThread(th);
    return root ? `codex:${root.id}/${th.id}` : `codex:${th.id}`;
  }

  hasLive() { return [...this.threads.values()].some((th) => th.live); }

  allEvents(limit) {
    const out = {};
    for (const th of this.threads.values()) out[this.keyOf(th)] = th.tr.events.slice(-limit);
    return out;
  }

  snapshot() {
    const subs = new Map();
    const tops = [];
    for (const th of this.threads.values()) {
      const root = this.rootThread(th);
      if (root) (subs.get(root.id) || subs.set(root.id, []).get(root.id)).push(th);
      else tops.push(th);
    }
    return tops.map((th) => this.summarize(th, subs.get(th.id) || []));
  }

  status(th) {
    const { tr } = th;
    if (!th.live) return 'offline';
    if (!tr.turn) return 'idle';
    const p = [...tr.pending.values()].at(-1);
    return p && ASKS.has(p.name) ? 'waiting' : 'working';
  }

  summarize(th, subs) {
    const { tr } = th;
    const m = tr.meta || {};
    const status = this.status(th);
    const cwd = tr.cwd || '';
    // Only a name the user gave counts as a title: titles are shared from the activity level, where
    // prompts are not. A name made from the first prompt is marked so share.js keeps it here.
    const name = String(this.names.get(th.id) || m.agent_nickname || '');
    return {
      key: `codex:${th.id}`,
      sessionId: th.id,
      pid: null,
      live: th.live,
      kind: 'codex',
      canMessage: false,
      name: name || tr.firstPrompt || path.basename(cwd) || th.id.slice(0, 8),
      nameFromPrompt: !name && !!tr.firstPrompt,
      title: name,
      project: path.basename(cwd),
      cwd,
      branch: tr.branch,
      model: tr.model,
      version: String(m.cli_version || ''),
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
      startedAt: Date.parse(m.timestamp) || tr.firstAt,
      lastAt: Math.max(tr.lastAt, th.tail.mtime || 0),
      job: null,
      subagents: subs
        .sort((a, b) => b.tail.mtime - a.tail.mtime)
        .map((s) => {
          const sm = s.tr.meta || {};
          const st = s.tr.turn && (s.live || th.live) ? 'working' : s.tr.turnEnded ? 'done' : 'idle';
          return {
            key: `codex:${th.id}/${s.id}`,
            agentId: s.id,
            type: String(sm.agent_role || sm.agent_type || sm.agent_nickname || 'subagent'),
            description: String(sm.agent_nickname || ''),
            toolUseId: null,
            status: st,
            now: activity(s.tr, st),
            model: s.tr.model,
            outTokens: s.tr.outTokens,
            cost: null,
            context: s.tr.context,
            toolCount: s.tr.toolCount,
            startedAt: Date.parse(sm.timestamp) || s.tr.firstAt,
            lastAt: Math.max(s.tr.lastAt, s.tail.mtime || 0),
          };
        }),
    };
  }
}
