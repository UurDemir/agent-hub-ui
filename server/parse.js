// Turns Claude Code transcript records (JSONL) into a compact stream of
// UI events, and keeps the running per-session state the dashboard needs.
import fs from 'node:fs';
import path from 'node:path';

const MAX_EVENTS = 400;

export const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const firstLine = (s) => String(s ?? '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
const base = (p) => (p ? path.basename(String(p)) : '');

// Reads a growing file from where it left off and returns complete JSON lines.
export class Tail {
  constructor(file, initialBytes) {
    this.file = file;
    this.initial = initialBytes;
    this.pos = -1;
    this.rest = null;
    this.mtime = 0;
  }

  read() {
    let st;
    try { st = fs.statSync(this.file); } catch { return []; }
    this.mtime = st.mtimeMs;
    let skipFirst = false;
    if (this.pos < 0) {
      this.pos = Math.max(0, st.size - this.initial);
      skipFirst = this.pos > 0; // started mid-line
    }
    if (st.size < this.pos) { this.pos = 0; this.rest = null; }
    if (st.size === this.pos) return [];

    const len = Math.min(st.size - this.pos, 16 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    try { fs.readSync(fd, buf, 0, len, this.pos); } finally { fs.closeSync(fd); }
    this.pos += len;

    const data = this.rest ? Buffer.concat([this.rest, buf]) : buf;
    const nl = data.lastIndexOf(10);
    if (nl < 0) { this.rest = data; return []; }
    this.rest = Buffer.from(data.subarray(nl + 1));
    const lines = data.subarray(0, nl).toString('utf8').split('\n');
    if (skipFirst) lines.shift();

    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* partial or corrupt line */ }
    }
    return out;
  }
}

const CATEGORY = {
  Read: 'read', Grep: 'read', Glob: 'read', LS: 'read', LSP: 'read', NotebookRead: 'read',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'run', PowerShell: 'run', Monitor: 'run', BashOutput: 'run', KillShell: 'run', TaskStop: 'run',
  WebFetch: 'web', WebSearch: 'web',
  Agent: 'agent', Task: 'agent', SendMessage: 'agent', ListAgents: 'agent',
  TodoWrite: 'plan', EnterPlanMode: 'plan', ExitPlanMode: 'plan', Skill: 'plan',
  AskUserQuestion: 'ask',
};

export const VERB = {
  read: 'Reading', edit: 'Editing', run: 'Running', web: 'Browsing', agent: 'Delegating',
  plan: 'Planning', mcp: 'Calling', ask: 'Asking you', other: 'Using',
};

export const toolCategory = (name) => (name.startsWith('mcp__') ? 'mcp' : CATEGORY[name] || 'other');

export function toolLabel(name) {
  if (!name.startsWith('mcp__')) return name;
  const [, server = '', ...rest] = name.split('__');
  return `${server.replace(/^plugin_[^_]+_/, '')} · ${rest.join('__')}`;
}

function toolSummary(name, input) {
  switch (name) {
    case 'Bash': case 'PowerShell': return input.description || firstLine(input.command);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return base(input.file_path || input.notebook_path);
    case 'Grep': return `"${input.pattern}"${input.path ? ' in ' + base(input.path) : ''}`;
    case 'Glob': return input.pattern;
    case 'WebFetch': try { return new URL(input.url).host; } catch { return input.url; }
    case 'WebSearch': return input.query;
    case 'Agent': case 'Task': return [input.description, input.subagent_type].filter(Boolean).join(' · ');
    case 'TodoWrite': return `${(input.todos || []).length} todos`;
    case 'Skill': return input.skill;
    case 'SendMessage': return `→ ${input.to || ''}`;
  }
  const v = Object.values(input).find((x) => typeof x === 'string');
  return firstLine(v);
}

function toolDetail(name, input) {
  switch (name) {
    case 'Bash': case 'PowerShell': return input.command;
    case 'Edit': return `${input.file_path}\n- ${clip(input.old_string, 500)}\n+ ${clip(input.new_string, 500)}`;
    case 'Write': return `${input.file_path}\n${String(input.content ?? '').split('\n').length} lines`;
    case 'Read': return input.file_path + (input.offset ? ` (from line ${input.offset})` : '');
    case 'Agent': case 'Task': return input.prompt;
    case 'TodoWrite':
      return (input.todos || []).map((t) =>
        `[${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n');
  }
  return JSON.stringify(input, null, 1);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n');
}

// Running state of one transcript (a session or a subagent).
export class Transcript {
  constructor() {
    this.events = [];
    this.pending = new Map(); // tool_use id -> tool event still waiting for a result
    this.seenMsg = new Set();
    this.seq = 0;
    this.outTokens = 0;
    this.context = 0;
    this.toolCount = 0;
    this.model = '';
    this.title = '';
    this.agentName = '';
    this.lastPrompt = '';
    this.branch = '';
    this.cwd = '';
    this.prs = [];
    this.todos = null;
    this.lastSay = null;
    this.phase = null; // { kind: thinking|writing|tool|result|done, t }
    this.stopReason = null;
    this.firstAt = 0;
    this.lastAt = 0;
  }

  ingest(j) {
    const t = j.timestamp ? Date.parse(j.timestamp) : 0;
    const out = [];
    if (j.cwd) this.cwd = j.cwd;
    if (j.gitBranch && j.gitBranch !== 'HEAD') this.branch = j.gitBranch;

    switch (j.type) {
      case 'ai-title': this.title = j.aiTitle || this.title; break;
      case 'agent-name': this.agentName = j.agentName || this.agentName; break;
      case 'last-prompt': this.lastPrompt = clip(j.lastPrompt, 300); break;
      case 'pr-link':
        if (j.prUrl && !this.prs.some((p) => p.url === j.prUrl)) {
          this.prs.push({ url: j.prUrl, number: j.prNumber, repo: j.prRepository });
          out.push({ kind: 'pr', url: j.prUrl, text: `PR #${j.prNumber} ${j.prRepository || ''}` });
        }
        break;
      case 'system':
        if (j.subtype === 'compact_boundary') out.push({ kind: 'note', text: 'Context compacted' });
        break;
      case 'assistant': this.assistant(j, t, out); break;
      case 'user': this.user(j, t, out); break;
    }

    if (t && (j.type === 'assistant' || j.type === 'user')) {
      if (!this.firstAt) this.firstAt = t;
      this.lastAt = Math.max(this.lastAt, t);
    }
    for (const e of out) {
      e.id = `${j.uuid || 'r'}:${this.seq++}`;
      e.t = e.t || t || Date.now();
      this.events.push(e);
    }
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return out;
  }

  assistant(j, t, out) {
    const m = j.message || {};
    if (m.model && !m.model.startsWith('<')) this.model = m.model;
    const u = m.usage;
    if (u) {
      if (m.id && !this.seenMsg.has(m.id)) {
        this.seenMsg.add(m.id);
        this.outTokens += u.output_tokens || 0;
      }
      this.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    if (m.stop_reason) this.stopReason = m.stop_reason;

    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c.type === 'thinking' || c.type === 'redacted_thinking') {
        this.phase = { kind: 'thinking', t };
      } else if (c.type === 'text' && c.text?.trim()) {
        out.push({ kind: 'say', text: clip(c.text.trim(), 2500) });
        this.lastSay = { text: clip(c.text.trim(), 400), t };
        this.phase = { kind: 'writing', t };
      } else if (c.type === 'tool_use') {
        const input = c.input || {};
        const cat = toolCategory(c.name);
        const e = {
          kind: 'tool', toolId: c.id, name: c.name, label: toolLabel(c.name), cat,
          summary: clip(toolSummary(c.name, input), 180), detail: clip(toolDetail(c.name, input), 1500),
        };
        this.pending.set(c.id, { ...e, t });
        this.toolCount++;
        if (c.name === 'TodoWrite' && Array.isArray(input.todos)) {
          this.todos = input.todos.map((x) => ({ content: clip(x.content, 200), status: x.status }));
        }
        out.push(e);
        this.phase = { kind: 'tool', t };
      }
    }
    if (m.stop_reason === 'end_turn') {
      this.pending.clear();
      this.phase = { kind: 'done', t };
    }
  }

  user(j, t, out) {
    const content = j.message?.content;
    if (typeof content === 'string') return this.prompt(content, j, t, out);
    if (!Array.isArray(content)) return;
    for (const x of content) {
      if (x.type === 'tool_result') {
        const p = this.pending.get(x.tool_use_id);
        this.pending.delete(x.tool_use_id);
        out.push({
          kind: 'result', toolId: x.tool_use_id, ok: !x.is_error,
          text: clip(resultText(x.content).trim(), 900), ms: p && t ? t - p.t : null,
        });
        this.phase = { kind: 'result', t };
      } else if (x.type === 'text') {
        this.prompt(x.text, j, t, out);
      }
    }
  }

  prompt(text, j, t, out) {
    if (j.isMeta || !text) return;
    text = text.trim();
    if (text.startsWith('[Request interrupted')) {
      this.pending.clear();
      this.phase = { kind: 'done', t };
      out.push({ kind: 'note', text: 'Interrupted by user' });
      return;
    }
    const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
    if (cmd) {
      const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || '';
      out.push({ kind: 'prompt', text: clip(`${cmd[1]} ${args}`.trim(), 1500) });
      return;
    }
    if (text.startsWith('<task-notification')) {
      const sum = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];
      out.push({ kind: 'note', text: clip(sum || 'Background task finished', 300) });
      return;
    }
    if (text.startsWith('<')) return; // reminders, command output and other injected context
    this.pending.clear();
    this.phase = { kind: 'prompt', t };
    out.push({ kind: 'prompt', text: clip(text, 1500) });
  }
}

// One-line "what is it doing right now" for a transcript, given its status.
export function activity(tr, status, extra = {}) {
  if (status === 'working') {
    const p = [...tr.pending.values()].at(-1);
    if (p) return { verb: VERB[p.cat], label: p.label, summary: p.summary, cat: p.cat, since: p.t };
    const ph = tr.phase;
    if (ph?.kind === 'thinking') return { verb: 'Thinking', since: ph.t };
    if (ph?.kind === 'writing') return { verb: 'Writing', summary: tr.lastSay?.text, since: ph.t };
    return { verb: 'Working', since: ph?.t || tr.lastAt };
  }
  if (status === 'waiting') return { verb: 'Needs you', summary: extra.detail || tr.lastSay?.text, since: extra.since };
  if (status === 'done') return { verb: 'Finished', summary: tr.lastSay?.text, since: tr.lastAt };
  if (status === 'idle') return { verb: 'Your turn', summary: tr.lastSay?.text, since: extra.since || tr.lastAt };
  return { verb: 'Ended', summary: tr.lastSay?.text, since: tr.lastAt };
}
