// Past Claude Code sessions on this PC (the History page) and token use per day (the Usage page),
// read from the transcripts under ~/.claude/projects. Read-only and on demand: nothing is scanned
// until a page asks, and per-file results are cached by size and mtime.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DIR } from './claude.js';
import { Transcript, clip, costRates, transcriptCost } from './parse.js';

const HEAD = 256 * 1024;
const MAX_SESSION_BYTES = 8 * 1024 * 1024; // a past session shows its last 8 MB
const SEARCH_BUDGET_MS = 4000;
const SEARCH_FILES = 400;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

// A session in a Claude Code worktree (<repo>/.claude/worktrees/<name>) belongs to <repo>, as on the canvas.
const WORKTREE_RE = /[\\/]\.claude[\\/]worktrees[\\/].*$/;
const projectOf = (cwd, folder) => path.basename(String(cwd || '').replace(WORKTREE_RE, '')) || folder;

const readdir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const statOf = (f) => { try { return fs.statSync(f); } catch { return null; } };
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function readRange(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

// Text a person typed in a user record (not tool results, not injected context).
function promptText(j) {
  if (j?.type !== 'user' || j.isMeta || j.isCompactSummary) return '';
  const c = j.message?.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : '';
  const s = String(t || '').trim();
  return s.startsWith('<') || s.startsWith('[Request interrupted') ? '' : s;
}
const replyText = (j) => (j?.type === 'assistant' && Array.isArray(j.message?.content)
  ? j.message.content.filter((x) => x?.type === 'text').map((x) => x.text).join('\n').trim() : '');

// Every top-level session transcript: { id, file, project folder, mtime, size }.
function sessionFiles() {
  const out = [];
  for (const d of readdir(DIR.projects)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(DIR.projects, d.name);
    for (const f of readdir(dir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, f.name);
      const st = statOf(file);
      if (st) out.push({ id: f.name.slice(0, -6), folder: d.name, file, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export class LocalHistory {
  meta = new Map();  // file -> { stamp, value }
  usage = new Map(); // file -> { stamp, value }

  // A session's card: read from its first and last 256 KB, cached until the file changes.
  info(f) {
    const stamp = `${f.size}:${f.mtime}`;
    const hit = this.meta.get(f.file);
    if (hit?.stamp === stamp) return hit.value;
    const v = { id: f.id, title: '', firstPrompt: '', cwd: '', branch: '', model: '', startedAt: 0, lastAt: f.mtime };
    try {
      const head = readRange(f.file, 0, Math.min(HEAD, f.size)).split('\n');
      if (f.size > HEAD) head.pop();
      for (const line of head) {
        const j = parse(line);
        if (!j) continue;
        if (!v.startedAt && j.timestamp) v.startedAt = Date.parse(j.timestamp) || 0;
        if (j.cwd && !v.cwd) v.cwd = j.cwd;
        if (j.gitBranch && j.gitBranch !== 'HEAD' && !v.branch) v.branch = j.gitBranch;
        if (!v.firstPrompt) v.firstPrompt = clip(promptText(j), 200);
      }
      const start = Math.max(0, f.size - HEAD);
      const tail = readRange(f.file, start, f.size - start).split('\n');
      if (start > 0) tail.shift();
      for (const line of tail) {
        const j = parse(line);
        if (!j) continue;
        if (j.type === 'ai-title' && j.aiTitle) v.title = clip(j.aiTitle, 200);
        if (j.type === 'agent-name' && j.agentName) v.title = clip(j.agentName, 200);
        if (j.type === 'assistant' && j.message?.model && !j.message.model.startsWith('<')) v.model = j.message.model;
        if (j.timestamp) v.lastAt = Math.max(v.lastAt, Date.parse(j.timestamp) || 0);
      }
    } catch { /* vanished or unreadable */ }
    this.meta.set(f.file, { stamp, value: v });
    return v;
  }

  card(f, extra = {}) {
    const v = this.info(f);
    return {
      key: v.id, local: true, name: v.title || v.firstPrompt || path.basename(v.cwd) || v.id.slice(0, 8),
      title: v.title, prompt: v.firstPrompt, project: projectOf(v.cwd, f.folder), cwd: v.cwd, branch: v.branch,
      model: v.model, startedAt: v.startedAt, lastAt: v.lastAt, size: f.size, ...extra,
    };
  }

  // Newest first; with q, only sessions whose prompts or replies contain it (with a snippet).
  async list({ q = '', before = Infinity, limit = 50 } = {}) {
    const files = sessionFiles().filter((f) => f.mtime < before);
    const needle = q.trim().toLowerCase();
    if (!needle) return { sessions: files.slice(0, limit).map((f) => this.card(f)), more: files.length > limit };
    const out = [];
    const end = Date.now() + SEARCH_BUDGET_MS;
    let scanned = 0;
    for (const f of files) {
      if (out.length >= limit || scanned >= SEARCH_FILES || Date.now() > end) break;
      scanned++;
      const hit = await findIn(f.file, needle);
      if (hit) out.push(this.card(f, { match: hit }));
    }
    const stopped = scanned < files.length && out.length < limit;
    return { sessions: out, more: out.length >= limit || stopped, scanned, stoppedAt: stopped ? files[scanned - 1]?.mtime : null };
  }

  // One past session: its card and its last events, as the live view would show them.
  session(id) {
    if (!ID_RE.test(id)) return null;
    const f = sessionFiles().find((x) => x.id === id);
    if (!f) return null;
    const start = Math.max(0, f.size - MAX_SESSION_BYTES);
    const lines = readRange(f.file, start, f.size - start).split('\n');
    if (start > 0) lines.shift();
    const tr = new Transcript();
    for (const line of lines) { const j = parse(line); if (j) tr.ingest(j); }
    const rates = costRates([tr.costState].filter(Boolean));
    return {
      agent: {
        ...this.card(f), key: `history:${f.id}`, sessionId: f.id, status: 'offline', live: false, kind: '',
        model: tr.model, outTokens: tr.outTokens, context: tr.context, toolCount: tr.toolCount,
        cost: transcriptCost(tr, rates), todos: tr.todos, prs: tr.prs, lastPrompt: tr.lastPrompt, lastSay: tr.lastSay,
        now: { verb: 'Ended', since: tr.lastAt }, subagents: [], truncated: start > 0,
      },
      events: tr.events,
    };
  }

  // Tokens and estimated cost per day, project and model, over the last `days` days.
  async usageReport(days = 30) {
    days = Math.min(Math.max(1, Math.round(days)), 120);
    const since = Date.now() - days * 86400e3;
    const files = [];
    for (const f of sessionFiles()) {
      if (f.mtime < since) break; // sorted newest first
      files.push(f);
      // Subagent transcripts count toward their parent's project.
      const subDir = path.join(path.dirname(f.file), f.id, 'subagents');
      for (const s of readdir(subDir)) {
        if (!s.isFile() || !s.name.endsWith('.jsonl')) continue;
        const file = path.join(subDir, s.name);
        const st = statOf(file);
        if (st && st.mtimeMs >= since) files.push({ ...f, file, mtime: st.mtimeMs, size: st.size, sub: true });
      }
    }
    const per = [];
    const costStates = [];
    for (const f of files) {
      const u = await this.fileUsage(f);
      per.push({ f, u });
      if (u.costState) costStates.push(u.costState);
    }
    const rates = costRates(costStates);
    const day = new Map(), project = new Map(), model = new Map();
    const add = (map, k, b, cost, extra = {}) => {
      const x = map.get(k) || { ...extra, in: 0, out: 0, cacheWrite: 0, cacheRead: 0, cost: 0, priced: false, sessions: new Set() };
      x.in += b.in; x.out += b.out; x.cacheWrite += b.cw; x.cacheRead += b.cr;
      if (cost != null) { x.cost += cost; x.priced = true; }
      map.set(k, x);
      return x;
    };
    const sinceDay = dayOf(since);
    for (const { f, u } of per) {
      const proj = projectOf(this.info(f).cwd, f.folder);
      for (const [k, b] of u.buckets) {
        const [d, m] = k.split('\n');
        if (d < sinceDay) continue;
        const cost = transcriptCost({ usage: new Map([['x', { model: m, ...b }]]) }, rates);
        add(day, d, b, cost, { day: d }).sessions.add(f.id);
        add(project, proj, b, cost, { project: proj }).sessions.add(f.id);
        add(model, m || 'unknown', b, cost, { model: m || 'unknown' }).sessions.add(f.id);
      }
    }
    const rows = (map) => [...map.values()].map(({ sessions, ...x }) => ({ ...x, sessions: sessions.size }));
    return {
      days, priced: Object.keys(rates).length > 0,
      byDay: rows(day).sort((a, b) => a.day.localeCompare(b.day)),
      byProject: rows(project).sort((a, b) => b.out - a.out),
      byModel: rows(model).sort((a, b) => b.out - a.out),
    };
  }

  // Per-message usage of one transcript, by local day and model (deduped by message id).
  async fileUsage(f) {
    const stamp = `${f.size}:${f.mtime}`;
    const hit = this.usage.get(f.file);
    if (hit?.stamp === stamp) return hit.value;
    const msgs = new Map();
    let costState = null;
    await eachLine(f.file, (line) => {
      if (!line.includes('"usage"') && !line.includes('"cost-state"')) return;
      const j = parse(line);
      if (j?.type === 'cost-state') { costState = { total: j.totalCostUSD, models: j.modelUsage || {} }; return; }
      const m = j?.type === 'assistant' ? j.message : null;
      const u = m?.usage;
      if (!u || !m.id) return;
      const prev = msgs.get(m.id);
      const t = Date.parse(j.timestamp) || f.mtime;
      msgs.set(m.id, {
        day: prev?.day || dayOf(t), model: m.model && !m.model.startsWith('<') ? m.model : prev?.model || '',
        in: Math.max(prev?.in || 0, u.input_tokens || 0), out: Math.max(prev?.out || 0, u.output_tokens || 0),
        cw: Math.max(prev?.cw || 0, u.cache_creation_input_tokens || 0), cr: Math.max(prev?.cr || 0, u.cache_read_input_tokens || 0),
      });
    });
    const buckets = new Map();
    for (const x of msgs.values()) {
      const k = `${x.day}\n${x.model}`;
      const b = buckets.get(k) || { in: 0, out: 0, cw: 0, cr: 0 };
      b.in += x.in; b.out += x.out; b.cw += x.cw; b.cr += x.cr;
      buckets.set(k, b);
    }
    const value = { buckets, costState };
    this.usage.set(f.file, { stamp, value });
    return value;
  }
}

// Local calendar day, YYYY-MM-DD.
export function dayOf(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try { for await (const line of rl) fn(line); } catch { /* vanished */ } finally { rl.close(); }
}

// The first prompt or reply in a transcript containing the needle, as a short snippet.
// The file is searched as one lowercased string (much faster than line by line); only the lines
// around a hit are parsed, to check that it's in a prompt or reply and not in a tool's output.
const SEARCH_MAX_BYTES = 64 * 1024 * 1024;
async function findIn(file, needle) {
  let raw;
  try {
    const st = await fs.promises.stat(file);
    if (st.size > SEARCH_MAX_BYTES) {
      const fh = await fs.promises.open(file, 'r');
      try {
        const buf = Buffer.alloc(SEARCH_MAX_BYTES);
        const { bytesRead } = await fh.read(buf, 0, SEARCH_MAX_BYTES, st.size - SEARCH_MAX_BYTES);
        raw = buf.subarray(0, bytesRead).toString('utf8');
      } finally { await fh.close(); }
    } else raw = await fs.promises.readFile(file, 'utf8');
  } catch { return null; }
  const lower = raw.toLowerCase();
  // JSON escapes quotes and backslashes, so look for the needle as it appears inside a string.
  const enc = JSON.stringify(needle).slice(1, -1);
  for (let at = lower.indexOf(enc); at >= 0; at = lower.indexOf(enc, at + 1)) {
    const start = lower.lastIndexOf('\n', at) + 1;
    let end = lower.indexOf('\n', at);
    if (end < 0) end = lower.length;
    const j = parse(raw.slice(start, end));
    at = end;
    const who = j?.type === 'user' ? 'prompt' : 'reply';
    const text = who === 'prompt' ? promptText(j) : replyText(j);
    const i = text.toLowerCase().indexOf(needle);
    if (i < 0) continue;
    const from = Math.max(0, i - 60);
    return { who, t: Date.parse(j.timestamp) || 0, text: `${from ? '…' : ''}${text.slice(from, i + needle.length + 100).replace(/\s+/g, ' ')}` };
  }
  return null;
}
