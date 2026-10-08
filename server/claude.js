// Watches Claude Code's local state (~/.claude): live sessions, their
// transcripts, background jobs and subagents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Tail, Transcript, activity, clip, costRates, transcriptCost } from './parse.js';

const ROOT = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const DIR = {
  sessions: path.join(ROOT, 'sessions'),
  projects: path.join(ROOT, 'projects'),
  jobs: path.join(ROOT, 'jobs'),
};
const RECENT_MS = 3 * 3600e3;   // keep ended sessions visible this long
const MAX_RECENT = 10;
const SUB_WINDOW_MS = 6 * 3600e3;
const MAX_SUBS = 15;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readdir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const slug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

export class ClaudeCollector extends EventEmitter {
  sessions = new Map(); // sessionId -> session record
  ticks = 0;

  start() {
    this.scanRecent();
    this.tick();
    setInterval(() => this.tick(), 1000);
    setInterval(() => this.scanRecent(), 15000);
  }

  tick() {
    try {
      this.scanLive();
      for (const s of this.sessions.values()) {
        if (s.live || this.ticks % 5 === 0) this.update(s);
      }
    } catch (e) {
      console.error('[claude] tick failed:', e);
    }
    this.ticks++;
    this.emit('tick');
  }

  newSession(sessionId, file = null) {
    const s = {
      sessionId, file, tail: file ? new Tail(file, 1024 * 1024) : null, tr: new Transcript(),
      subs: new Map(), info: null, live: false, endedAt: 0, job: null, jobMtime: 0, lookAt: 0, subScanAt: 0,
    };
    this.sessions.set(sessionId, s);
    return s;
  }

  scanLive() {
    const seen = new Set();
    for (const f of readdir(DIR.sessions)) {
      if (!f.endsWith('.json')) continue;
      const info = readJson(path.join(DIR.sessions, f));
      if (!info?.sessionId || info.spare || !isAlive(info.pid)) continue;
      const s = this.sessions.get(info.sessionId) || this.newSession(info.sessionId);
      s.info = info;
      s.live = true;
      seen.add(info.sessionId);
    }
    for (const s of this.sessions.values()) {
      if (s.live && !seen.has(s.sessionId)) { s.live = false; s.endedAt = Date.now(); }
    }
  }

  update(s) {
    if (!s.file && Date.now() - s.lookAt > 3000) {
      s.lookAt = Date.now();
      s.file = this.findTranscript(s.sessionId, s.info?.cwd);
      if (s.file) s.tail = new Tail(s.file, 1536 * 1024);
    }
    if (s.tail) this.pump(s.sessionId, s.tail, s.tr);
    if (s.info?.jobId) this.readJob(s);
    if (s.file && Date.now() - s.subScanAt > 2000) { s.subScanAt = Date.now(); this.scanSubs(s); }
    for (const sub of s.subs.values()) this.pump(`${s.sessionId}/${sub.agentId}`, sub.tail, sub.tr);
  }

  pump(key, tail, tr) {
    const records = tail.read();
    if (!records.length) return;
    const events = [];
    for (const r of records) events.push(...tr.ingest(r));
    if (events.length) this.emit('events', key, events);
  }

  findTranscript(sessionId, cwd) {
    const name = sessionId + '.jsonl';
    if (cwd) {
      const f = path.join(DIR.projects, slug(cwd), name);
      if (fs.existsSync(f)) return f;
    }
    for (const d of readdir(DIR.projects)) {
      const f = path.join(DIR.projects, d, name);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  readJob(s) {
    const f = path.join(DIR.jobs, s.info.jobId, 'state.json');
    let st;
    try { st = fs.statSync(f); } catch { return; }
    if (st.mtimeMs === s.jobMtime) return;
    s.jobMtime = st.mtimeMs;
    s.job = readJson(f) || s.job;
  }

  scanSubs(s) {
    const dir = path.join(path.dirname(s.file), s.sessionId, 'subagents');
    const now = Date.now();
    for (const f of readdir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const agentId = f.slice(0, -6).replace(/^agent-/, '');
      if (s.subs.has(agentId)) continue;
      const file = path.join(dir, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (now - st.mtimeMs > SUB_WINDOW_MS) continue;
      const tail = new Tail(file, 512 * 1024);
      tail.mtime = st.mtimeMs;
      s.subs.set(agentId, {
        agentId, tail, tr: new Transcript(),
        meta: readJson(path.join(dir, f.slice(0, -6) + '.meta.json')) || {},
      });
    }
    if (s.subs.size > MAX_SUBS) {
      const old = [...s.subs.values()].sort((a, b) => a.tail.mtime - b.tail.mtime);
      for (const sub of old.slice(0, s.subs.size - MAX_SUBS)) s.subs.delete(sub.agentId);
    }
  }

  // Picks up transcripts touched recently that don't belong to a live process.
  scanRecent() {
    const now = Date.now();
    const found = [];
    for (const d of readdir(DIR.projects)) {
      const dir = path.join(DIR.projects, d);
      for (const f of readdir(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        try {
          const st = fs.statSync(path.join(dir, f));
          if (now - st.mtimeMs < RECENT_MS) found.push({ sid: f.slice(0, -6), file: path.join(dir, f), mtime: st.mtimeMs });
        } catch { /* vanished */ }
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    const keep = new Set(found.slice(0, MAX_RECENT).map((x) => x.sid));
    for (const x of found.slice(0, MAX_RECENT)) {
      if (!this.sessions.has(x.sid)) this.update(this.newSession(x.sid, x.file));
    }
    for (const [sid, s] of this.sessions) {
      if (!s.live && !keep.has(sid) && now - (s.endedAt || 0) > RECENT_MS) this.sessions.delete(sid);
    }
  }

  allEvents(limit) {
    const out = {};
    for (const s of this.sessions.values()) {
      out[s.sessionId] = s.tr.events.slice(-limit);
      for (const sub of s.subs.values()) out[`${s.sessionId}/${sub.agentId}`] = sub.tr.events.slice(-limit);
    }
    return out;
  }

  snapshot() {
    // A resumed background job writes to a new transcript; its old one is named after the job id.
    const liveJobs = [...this.sessions.values()].filter((s) => s.live && s.info?.jobId).map((s) => s.info.jobId);
    // Per-model rates are the same for every session, so any session's cost record prices all of them.
    const rates = costRates([...this.sessions.values()].map((s) => s.tr.costState).filter(Boolean));
    return [...this.sessions.values()]
      .filter((s) => (s.file || s.live) && (s.live || !liveJobs.some((j) => s.sessionId.startsWith(j))))
      .map((s) => this.summarize(s, rates));
  }

  summarize(s, rates = {}) {
    const { tr } = s;
    const info = s.info || {};
    let status;
    if (!s.live) status = 'offline';
    else if (info.status === 'busy') status = 'working';
    else if (info.status === 'idle') status = s.job?.state === 'blocked' ? 'waiting' : 'idle';
    else status = 'waiting';

    const cwd = info.cwd || tr.cwd || '';
    const since = info.statusUpdatedAt || tr.lastAt;
    const now = Date.now();
    return {
      key: s.sessionId,
      sessionId: s.sessionId,
      pid: info.pid ?? null,
      live: s.live,
      kind: info.kind || '',
      name: tr.agentName || info.name || tr.title || clip(tr.lastPrompt, 60) || path.basename(cwd) || s.sessionId.slice(0, 8),
      title: tr.title,
      project: path.basename(cwd),
      cwd,
      branch: tr.branch,
      model: tr.model,
      version: info.version || '',
      status,
      rawStatus: info.status || '',
      now: activity(tr, status, { detail: s.job?.detail, since }),
      lastSay: tr.lastSay,
      lastPrompt: tr.lastPrompt,
      prs: tr.prs,
      todos: tr.todos,
      outTokens: tr.outTokens,
      cost: transcriptCost(tr, rates),
      context: tr.context,
      toolCount: tr.toolCount,
      startedAt: info.startedAt || tr.firstAt,
      lastAt: Math.max(tr.lastAt, s.tail?.mtime || 0),
      job: s.job && {
        state: s.job.state,
        detail: s.job.detail,
        intent: s.job.intent,
        fan: (s.job.fan || []).map((f) => ({ id: f.id, kind: f.kind, label: f.label, startedAt: f.startedAt })),
      },
      subagents: [...s.subs.values()]
        .sort((a, b) => b.tail.mtime - a.tail.mtime)
        .map((sub) => {
          const age = now - sub.tail.mtime;
          const finished = sub.tr.stopReason === 'end_turn' || sub.tr.handedBack;
          const st = age < 15000 || (!finished && sub.tr.pending.size && status === 'working' && age < 600e3)
            ? 'working'
            : finished ? 'done' : 'idle';
          return {
            key: `${s.sessionId}/${sub.agentId}`,
            agentId: sub.agentId,
            type: sub.meta.agentType || 'subagent',
            description: sub.meta.description || '',
            toolUseId: sub.meta.toolUseId || null, // the parent's Agent tool call that spawned it
            status: st,
            now: activity(sub.tr, st),
            model: sub.tr.model,
            outTokens: sub.tr.outTokens,
            cost: transcriptCost(sub.tr, rates),
            context: sub.tr.context,
            toolCount: sub.tr.toolCount,
            startedAt: sub.tr.firstAt,
            lastAt: sub.tail.mtime,
          };
        }),
    };
  }
}
