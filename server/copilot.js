// Watches GitHub Copilot CLI's local sessions ($COPILOT_HOME, default ~/.copilot). Each session is a
// folder session-state/<session id>/ holding its event log (events.jsonl: one session event per line,
// {type, data, id, timestamp, parentId, agentId?}), its metadata (workspace.yaml) and, while a
// Copilot process has it open, an in-use lock inuse.<pid>.lock.
// The CLI isn't open source. The format was read from the published package (@github/copilot 1.0.40,
// whose app.js still has the writer in plain JS, and the 1.0.116 bundle and its
// schemas/session-events.schema.json, the same schema github.com/github/copilot-sdk generates its
// session event types from). Read-only: nothing under $COPILOT_HOME is ever written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SECRET_KEY, Tail, activity, clip, summaryFields, toolLabel } from './parse.js';
import { headLine } from './codex.js';

const ROOT = process.env.COPILOT_HOME?.trim() || path.join(os.homedir(), '.copilot');
export const COPILOT_DIR = { root: ROOT, sessions: path.join(ROOT, 'session-state') };
const RECENT_MS = 3 * 3600e3;   // keep ended sessions visible this long
const MAX_RECENT = 10;
const LIVE_MTIME_MS = 120e3;    // a lock with no Copilot process seen counts as live only this long after the last write
const BUSY_MS = 30 * 60e3;      // a run with no new event for this long no longer counts as working
const MAX_EVENTS = 400;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_RE = /^inuse\.(\d+)(?:\.[^.]+)?\.lock$/;

const readdir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const statOf = (f) => { try { return fs.statSync(f); } catch { return null; } };
const firstLine = (s) => String(s ?? '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
const base = (p) => (p ? path.basename(String(p)) : '');
const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
const str = (v) => (typeof v === 'string' ? v : '');

// The process holding a lock is running (Copilot checks its locks the same way).
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/* ---------- workspace.yaml ---------- */

// Top-level scalar keys of a workspace.yaml (written by the `yaml` package: plain, quoted or block
// scalars, long ones folded onto indented lines). Nested values are skipped.
export function yamlScalars(text) {
  const out = {};
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!m) continue;
    const cont = [];
    while (i + 1 < lines.length && (lines[i + 1] === '' || /^[ \t]/.test(lines[i + 1]))) cont.push(lines[++i]);
    while (cont.length && !cont.at(-1).trim()) cont.pop();
    const v = (m[2] ?? '').trim();
    if (/^[|>][-+]?\d*$/.test(v)) {
      const ind = Math.min(...cont.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length));
      const body = cont.map((l) => l.slice(ind));
      out[m[1]] = v[0] === '|' ? body.join('\n') : body.join(' ').replace(/ ?\n ?/g, '\n');
    } else if (v.startsWith('"')) {
      const s = [v, ...cont.map((l) => l.trim())].join(' ');
      const q = s.slice(0, s.lastIndexOf('"') + 1);
      try { out[m[1]] = JSON.parse(q); } catch { out[m[1]] = q.slice(1, -1); }
    } else if (v.startsWith("'")) {
      const s = [v, ...cont.map((l) => l.trim())].join(' ');
      out[m[1]] = s.slice(1, s.lastIndexOf("'") > 0 ? s.lastIndexOf("'") : undefined).replace(/''/g, "'");
    } else if (v) {
      const s = [v, ...cont.map((l) => l.trim())].filter(Boolean).join(' ').replace(/\s+#.*$/, '');
      out[m[1]] = s === 'true' ? true : s === 'false' ? false : s === 'null' || s === '~' ? null : s;
    }
  }
  return out;
}

/* ---------- tools ---------- */

const CATEGORY = {
  view: 'read', glob: 'read', grep: 'read', rg: 'read', lsp: 'read', show_file: 'read',
  read_bash: 'read', read_powershell: 'read', list_bash: 'read', list_powershell: 'read',
  fetch_copilot_cli_documentation: 'read',
  edit: 'edit', create: 'edit', str_replace_editor: 'edit', str_replace: 'edit', insert: 'edit', apply_patch: 'edit',
  bash: 'run', powershell: 'run', shell: 'run', local_shell: 'run',
  write_bash: 'run', write_powershell: 'run', stop_bash: 'run', stop_powershell: 'run',
  web_fetch: 'web', web_search: 'web',
  task: 'agent', read_agent: 'agent', write_agent: 'agent', list_agents: 'agent',
  update_todo: 'plan', report_intent: 'plan', exit_plan_mode: 'plan', skill: 'plan', task_complete: 'plan', sql: 'plan',
  ask_user: 'ask',
};
// MCP tools carry their server in the event; the GitHub server's built-in tools are github-mcp-server-<tool>.
const fullName = (d) => {
  const name = str(d.toolName) || 'tool';
  const server = str(d.mcpServerName);
  if (server) return `mcp__${server}__${str(d.mcpToolName) || name.replace(`${server}-`, '')}`;
  return name.startsWith('github-mcp-server-') ? `mcp__github-mcp-server__${name.slice(18)}` : name;
};
export const copilotCategory = (name) => (name.startsWith('mcp__') ? 'mcp' : CATEGORY[name] || 'other');

// Arguments can carry secrets (a header, a token): those keys never leave the collector.
const scrub = (v, depth = 0) => {
  if (Array.isArray(v)) return depth > 6 ? [] : v.map((x) => scrub(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  return depth > 6 ? {} : Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_KEY.test(k)).map(([k, x]) => [k, scrub(x, depth + 1)]));
};
const patchText = (a) => (typeof a === 'string' ? a : str(a.input) || str(a.patch));
const patchFiles = (patch) => [...String(patch).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
// update_todo takes a Markdown checklist (parsed the way Copilot does).
const todoList = (md) => [...String(md ?? '').matchAll(/^[\s]*(?:[-*+]|[0-9]+[.)])[ \t]*\[([ xX\-~/])\][ \t]*(.*)$/gm)]
  .filter((m) => m[2].trim())
  .map((m) => ({ content: clip(m[2].trim(), 200), status: /[xX]/.test(m[1]) ? 'completed' : m[1] === ' ' ? 'pending' : 'in_progress' }));

// a: the arguments object ({} when the tool got a plain string), raw: the arguments as sent.
function toolSummary(name, a, raw) {
  switch (name) {
    case 'bash': case 'powershell': case 'shell': case 'local_shell': return firstLine(a.command);
    case 'read_bash': case 'read_powershell': return 'Reading output';
    case 'write_bash': case 'write_powershell': return 'Sending input'; // typed input can be a password
    case 'stop_bash': case 'stop_powershell': return 'Stopping a shell';
    case 'list_bash': case 'list_powershell': return 'Listing shells';
    case 'view': case 'create': case 'edit': case 'str_replace_editor': case 'str_replace': case 'insert': case 'show_file':
      return base(a.path);
    case 'glob': return a.pattern;
    case 'grep': case 'rg': return `"${a.pattern ?? ''}"${a.path ? ' in ' + base(a.path) : ''}`;
    case 'apply_patch': {
      const files = patchFiles(patchText(raw));
      return files.length > 2 ? `${base(files[0])} +${files.length - 1} files` : files.map(base).join(', ');
    }
    case 'web_fetch': return host(a.url);
    case 'web_search': return a.query;
    case 'task': return str(a.agent_type) || 'Subagent'; // the task itself is a prompt: detail only
    case 'read_agent': return 'Reading a subagent';
    case 'write_agent': return 'Message to a subagent';
    case 'list_agents': return 'Listing subagents';
    case 'update_todo': return `${todoList(a.todos).length} todos`;
    case 'skill': return a.skill;
    case 'ask_user': return 'Question';
    case 'exit_plan_mode': return 'Plan ready';
    case 'task_complete': return 'Task complete';
    case 'fetch_copilot_cli_documentation': return 'Copilot CLI docs';
  }
  // Other tools (MCP, sql, custom tools) get their first text argument, marked freeText so a hub
  // only gets it at the full level (summaryFields in parse.js).
  return null;
}

function toolDetail(name, a) {
  switch (name) {
    case 'bash': case 'powershell': case 'shell': case 'local_shell': return str(a.command);
    case 'edit': case 'str_replace': return `${a.path ?? ''}\n- ${clip(a.old_str, 600)}\n+ ${clip(a.new_str, 600)}`;
    case 'create': return `${a.path ?? ''}\n${String(a.file_text ?? '').split('\n').length} lines`;
    case 'view': return `${a.path ?? ''}${Array.isArray(a.view_range) ? ` (lines ${a.view_range.join('-')})` : ''}`;
    case 'apply_patch': return patchText(a);
    case 'update_todo': return str(a.todos);
  }
  return typeof a === 'string' ? a : JSON.stringify(scrub(a), null, 1);
}

function resultText(d) {
  const r = d.result && typeof d.result === 'object' ? d.result : {};
  if (d.success === false && d.error?.message) return String(d.error.message);
  return str(r.content) || str(r.detailedContent) || str(d.error?.message);
}

/* ---------- one session ---------- */

// Running state of one Copilot session, shaped like parse.js's Transcript so activity() works on it.
export class CopilotTranscript {
  constructor() {
    this.events = [];
    this.pending = new Map();     // toolCallId -> tool event waiting for tool.execution_complete
    this.hidden = new Set();      // report_intent calls, which Copilot doesn't show either
    this.permissions = new Map(); // requestId -> toolCallId of a permission prompt still open
    this.seq = 0;
    this.cwd = '';
    this.branch = '';
    this.model = '';
    this.version = '';
    this.startedAt = 0;
    this.firstPrompt = '';
    this.lastPrompt = '';
    this.lastSay = null;
    this.outTokens = 0;
    this.context = 0;
    this.toolCount = 0;
    this.todos = null;
    this.busy = false;          // a run is in progress (from a prompt until a turn ends without tool calls)
    this.awaitingTools = false; // the last assistant message asked for tools: another turn follows
    this.ended = false;         // session.shutdown seen after the last start/resume
    this.phase = null;
    this.firstAt = 0;
    this.lastAt = 0;
  }

  setContext(c) {
    if (!c || typeof c !== 'object') return;
    if (c.cwd) this.cwd = String(c.cwd);
    if (c.branch) this.branch = String(c.branch);
  }

  ingest(j) {
    const out = [];
    if (!j || typeof j !== 'object' || typeof j.type !== 'string' || j.ephemeral === true || j.checkpoint === true) return out;
    const t = Date.parse(j.timestamp) || 0;
    const d = j.data && typeof j.data === 'object' ? j.data : {};
    if (t) {
      if (!this.firstAt) this.firstAt = t;
      this.lastAt = Math.max(this.lastAt, t);
    }

    switch (j.type) {
      case 'permission.requested': this.permissions.set(String(d.requestId ?? ''), String(d.permissionRequest?.toolCallId ?? '')); break;
      case 'permission.completed': this.permissions.delete(String(d.requestId ?? '')); break;
    }
    // A subagent's own events are copied into its parent's log; its task call stands for them here.
    if (j.agentId || d.parentToolCallId) return out;

    switch (j.type) {
      case 'session.start':
        this.endRun(t);
        this.ended = false;
        this.setContext(d.context);
        if (d.selectedModel) this.model = String(d.selectedModel);
        if (d.copilotVersion) this.version = String(d.copilotVersion);
        this.startedAt = Date.parse(d.startTime) || t;
        break;
      case 'session.resume':
        this.endRun(t); // a run that was going on belonged to the process that wrote it
        this.ended = false;
        this.setContext(d.context);
        if (d.selectedModel) this.model = String(d.selectedModel);
        break;
      case 'session.context_changed': this.setContext(d); break;
      case 'session.model_change': if (d.newModel) this.model = String(d.newModel); break;
      case 'session.shutdown':
        this.endRun(t);
        this.ended = true;
        if (d.currentTokens) this.context = Number(d.currentTokens) || this.context;
        break;
      case 'session.compaction_complete': if (d.success) out.push({ kind: 'note', text: 'Context compacted' }); break;
      case 'session.error':
        if (d.errorType === 'notification') break; // an extension's notice, not the end of a run
        out.push({ kind: 'note', text: clip(d.message || 'Error', 300) });
        this.endRun(t);
        break;
      case 'abort':
        out.push({ kind: 'note', text: 'Interrupted by user' });
        this.endRun(t);
        break;
      case 'user.message': this.prompt(d, t, out); break;
      case 'assistant.turn_start':
        this.busy = true;
        this.awaitingTools = false;
        if (d.model) this.model = String(d.model);
        this.phase = { kind: 'thinking', t };
        break;
      case 'assistant.reasoning': this.phase = { kind: 'thinking', t }; break; // never shown
      case 'assistant.message': {
        if (d.model) this.model = String(d.model);
        this.outTokens += Number(d.outputTokens) || 0;
        const text = str(d.content).trim(); // reasoningText / reasoningOpaque stay private
        if (text) {
          out.push({ kind: 'say', text: clip(text, 2500) });
          this.lastSay = { text: clip(text, 400), t };
          this.phase = { kind: 'writing', t };
        }
        this.awaitingTools = Array.isArray(d.toolRequests) && d.toolRequests.length > 0;
        break;
      }
      case 'assistant.turn_end':
        if (!this.awaitingTools && !this.pending.size) this.endRun(t);
        break;
      case 'tool.execution_start': this.tool(d, t, out); break;
      case 'tool.execution_complete': this.result(d, t, out); break;
    }

    for (const e of out) {
      e.id = `${j.id || 'r'}:${this.seq++}`;
      e.t = e.t || t || Date.now();
      this.events.push(e);
    }
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return out;
  }

  prompt(d, t, out) {
    this.busy = true;
    this.phase = { kind: 'prompt', t };
    if (d.agentAuthored === true) return; // sent by an agent, not typed
    const text = str(d.content).trim();
    if (!text) return;
    this.lastPrompt = clip(text, 300);
    if (!this.firstPrompt) this.firstPrompt = clip(text, 60);
    out.push({ kind: 'prompt', text: clip(text, 1500) });
  }

  tool(d, t, out) {
    const id = String(d.toolCallId || `call-${this.seq}`);
    const name = fullName(d);
    this.busy = true;
    if (name === 'report_intent') { this.hidden.add(id); return; }
    const raw = typeof d.arguments === 'string' ? d.arguments : d.arguments && typeof d.arguments === 'object' ? d.arguments : {};
    const a = typeof raw === 'string' ? {} : raw;
    // str_replace_editor also views files.
    const cat = name === 'str_replace_editor' && a.command === 'view' ? 'read' : copilotCategory(name);
    const e = {
      kind: 'tool', toolId: id, name, label: toolLabel(name), cat,
      ...summaryFields(toolSummary(name, a, raw), typeof raw === 'string' ? raw : scrub(a)),
      detail: clip(toolDetail(name, raw), 1500),
    };
    if (name === 'update_todo' && typeof a.todos === 'string') this.todos = todoList(a.todos);
    this.pending.set(id, { ...e, t });
    this.toolCount++;
    out.push(e);
    this.phase = { kind: 'tool', t };
  }

  result(d, t, out) {
    const id = String(d.toolCallId ?? '');
    if (this.hidden.delete(id)) return;
    const p = this.pending.get(id);
    this.pending.delete(id);
    const code = d.shellExecution?.exitCode;
    const ok = d.success === true && !(typeof code === 'number' && code !== 0);
    out.push({ kind: 'result', toolId: id, ok, text: clip(resultText(d).trim(), 900), ms: p && t ? t - p.t : null });
    this.phase = { kind: 'result', t };
  }

  endRun(t) {
    this.busy = false;
    this.awaitingTools = false;
    this.pending.clear();
    this.hidden.clear();
    this.permissions.clear();
    this.phase = { kind: 'done', t };
  }
}

/* ---------- collector ---------- */

export class CopilotCollector extends EventEmitter {
  sessions = new Map(); // session id (lowercase) -> session record
  ticks = 0;
  scans = 0;

  // running(): whether a Copilot CLI process is seen on this machine (ProcessScanner), to tell a
  // lock whose PID was reused after a crash from an idle session.
  constructor({ running = () => false, dir = COPILOT_DIR } = {}) {
    super();
    this.running = running;
    this.dir = dir;
  }

  start() {
    this.scanRecent();
    this.tick();
    setInterval(() => this.tick(), 1000);
    setInterval(() => this.scanRecent(), 10000);
  }

  tick() {
    try {
      for (const s of this.sessions.values()) {
        if (this.ticks % 2 === 0) this.setLive(s);
        if (s.live || this.ticks % 5 === 0) this.pump(s);
      }
    } catch (e) {
      console.error('[copilot] tick failed:', e);
    }
    this.ticks++;
    this.emit('tick');
  }

  // Sessions written to in the last hours, plus (on the first scan) ones a running Copilot has
  // open without having written lately.
  scanRecent() {
    const now = Date.now();
    const found = [];
    const first = this.scans++ === 0;
    for (const name of readdir(this.dir.sessions)) {
      if (!ID_RE.test(name)) continue;
      const id = name.toLowerCase();
      const folder = path.join(this.dir.sessions, name);
      const mtime = statOf(path.join(folder, 'events.jsonl'))?.mtimeMs || 0;
      if (!mtime) continue; // Copilot writes the log once the first prompt is sent
      const locked = !!this.sessions.get(id)?.live || (first && this.lockPids(folder).length > 0);
      if (locked || now - mtime < RECENT_MS) found.push({ id, folder, mtime, locked });
    }
    found.sort((a, b) => (Number(b.locked) - Number(a.locked)) || (b.mtime - a.mtime));
    const keep = new Set();
    for (const x of found) {
      if (keep.size >= MAX_RECENT && !x.locked) break;
      keep.add(x.id);
      if (!this.sessions.has(x.id)) this.add(x.id, x.folder);
    }
    for (const [id, s] of this.sessions) {
      if (!s.live && !keep.has(id)) this.sessions.delete(id);
      else this.readWorkspace(s);
    }
  }

  add(id, folder) {
    const file = path.join(folder, 'events.jsonl');
    const s = { id, folder, file, tail: new Tail(file, 1536 * 1024), tr: new CopilotTranscript(), live: false, ws: {}, wsMtime: 0 };
    this.head(s);
    this.sessions.set(id, s);
    this.readWorkspace(s);
    this.setLive(s);
    this.pump(s);
  }

  // session.start is the first line; a Tail that starts near the end of a long log skips it.
  head(s) {
    const first = headLine(s.file);
    if (first?.type === 'session.start') s.tr.ingest(first);
  }

  lockPids(folder) {
    return readdir(folder).map((f) => LOCK_RE.exec(f)?.[1]).filter(Boolean).map(Number).filter(pidAlive);
  }

  setLive(s) {
    const recent = Date.now() - (statOf(s.file)?.mtimeMs || 0) < LIVE_MTIME_MS;
    s.live = !s.tr.ended && this.lockPids(s.folder).length > 0 && (this.running() || recent);
  }

  pump(s) {
    // /undo and /rewind rewrite the log shorter: start over.
    const size = statOf(s.file)?.size ?? -1;
    if (size >= 0 && s.tail.pos > size) {
      s.tr = new CopilotTranscript();
      s.tail = new Tail(s.file, 1536 * 1024);
      this.head(s);
    }
    const records = s.tail.read();
    if (!records.length) return;
    const events = [];
    for (const r of records) events.push(...s.tr.ingest(r));
    if (events.length) this.emit('events', `copilot:${s.id}`, events);
  }

  readWorkspace(s) {
    const file = path.join(s.folder, 'workspace.yaml');
    const m = statOf(file)?.mtimeMs || 0;
    if (!m || m === s.wsMtime) return;
    s.wsMtime = m;
    try { s.ws = yamlScalars(fs.readFileSync(file, 'utf8')); } catch { /* keep the last one */ }
  }

  hasLive() { return [...this.sessions.values()].some((s) => s.live); }

  allEvents(limit) {
    const out = {};
    for (const s of this.sessions.values()) out[`copilot:${s.id}`] = s.tr.events.slice(-limit);
    return out;
  }

  snapshot() {
    return [...this.sessions.values()].map((s) => this.summarize(s));
  }

  status(s) {
    const { tr } = s;
    if (!s.live) return 'offline';
    if (!tr.busy || Date.now() - Math.max(tr.lastAt, s.tail.mtime || 0) > BUSY_MS) return 'idle';
    if (tr.permissions.size) return 'waiting';
    return [...tr.pending.values()].at(-1)?.name === 'ask_user' ? 'waiting' : 'working';
  }

  waitingFor(tr) {
    const ids = [...tr.permissions.values()];
    const p = tr.pending.get(ids.at(-1)) || [...tr.pending.values()].at(-1);
    return p?.summary || (ids.length ? 'Permission requested' : undefined);
  }

  summarize(s) {
    const { tr, ws } = s;
    const status = this.status(s);
    const cwd = tr.cwd || str(ws.cwd);
    // Only a name the user gave (/rename, --name) counts as a title: titles are shared from the
    // activity level, where prompts are not. Copilot's own summary of the conversation, or the
    // first prompt, is marked so share.js keeps it on this machine below full.
    const given = ws.user_named === true ? str(ws.name) : '';
    const derived = str(ws.name) || str(ws.summary) || tr.firstPrompt;
    return {
      key: `copilot:${s.id}`,
      sessionId: s.id,
      pid: null,
      live: s.live,
      kind: 'copilot',
      canMessage: false,
      name: given || derived || path.basename(cwd) || s.id.slice(0, 8),
      nameFromPrompt: !given && !!derived,
      title: given,
      project: path.basename(cwd),
      cwd,
      branch: tr.branch || str(ws.branch),
      model: tr.model,
      version: tr.version,
      status,
      rawStatus: tr.busy ? 'run' : '',
      now: activity(tr, status, {
        since: tr.phase?.t || tr.lastAt,
        detail: status === 'waiting' ? this.waitingFor(tr) : undefined,
      }),
      lastSay: tr.lastSay,
      lastPrompt: tr.lastPrompt,
      prs: [],
      todos: tr.todos,
      outTokens: tr.outTokens,
      cost: null,
      context: tr.context,
      toolCount: tr.toolCount,
      startedAt: tr.startedAt || Date.parse(ws.created_at) || tr.firstAt,
      lastAt: Math.max(tr.lastAt, s.tail.mtime || 0),
      job: null,
      subagents: [],
    };
  }
}
