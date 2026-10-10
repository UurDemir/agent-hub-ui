// What a machine reporting to a hub sends, at each sharing level. Every field is listed with the
// lowest level allowed to send it and how to coerce it. A field added to the agent summary or to
// an event later stays on this machine until it is listed here, and a hub only ever passes on
// plain strings and numbers (they end up in the dashboard's HTML). The reporter and the hub
// both run data through this, so neither can send or show more than its level allows.
import { VERB } from './parse.js';

export const LEVELS = ['metadata', 'activity', 'full'];
export const levelOf = (s) => (LEVELS.includes(s) ? s : null);
export const minLevel = (a, b) => LEVELS[Math.min(LEVELS.indexOf(a), LEVELS.indexOf(b))];

const M = 0; // metadata
const A = 1; // activity
const F = 2; // full
const rank = (level) => {
  const r = LEVELS.indexOf(level);
  if (r < 0) throw new Error(`Unknown sharing level: ${level}`);
  return r;
};

const STATUSES = ['working', 'waiting', 'idle', 'offline', 'done'];
const CATS = Object.keys(VERB);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v) => num(v) ?? 0;
const bool = (v) => v === true;
const str = (n) => (v) => (v == null || typeof v === 'object' ? '' : String(v).slice(0, n));
const oneOf = (list, d) => (v) => (list.includes(v) ? v : d);
const S = str(200);

// shape({ field: [minLevel, coerce] }) -> (value, level) -> plain object with the allowed fields.
const shape = (schema) => (v, level) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [k, [min, fn]] of Object.entries(schema)) if (level >= min) out[k] = fn(v[k], level);
  return out;
};
const list = (fn, max) => (v, level) =>
  (Array.isArray(v) ? v.slice(0, max).map((x) => fn(x, level)).filter((x) => x != null) : []);

const nowShape = shape({ verb: [M, S], cat: [M, oneOf(CATS, null)], label: [A, S], since: [M, num] });
// At the activity level a summary is only sent when it describes a tool call; otherwise it is
// Claude's last reply.
const now = (v, level) => {
  const out = nowShape(v, level);
  if (out && (level >= F || (level >= A && v.label))) out.summary = str(400)(v.summary);
  return out;
};

const TODO = shape({ content: [A, str(300)], status: [A, oneOf(['pending', 'in_progress', 'completed'], 'pending')] });
const PR = shape({ url: [A, str(500)], number: [A, num], repo: [A, S] });
const SAY = shape({ text: [F, str(500)], t: [F, num] });
const JOB = shape({
  state: [M, S], detail: [F, str(2000)], intent: [F, str(2000)],
  fan: [F, list(shape({ id: [F, S], kind: [F, S], label: [F, S], startedAt: [F, num] }), 50)],
});
const SUB = shape({
  key: [M, S], agentId: [M, S], type: [M, S], toolUseId: [M, S],
  status: [M, oneOf(['working', 'idle', 'done'], 'idle')], now: [M, now],
  model: [M, S], outTokens: [M, count], cost: [M, num], context: [M, count], toolCount: [M, count],
  startedAt: [M, num], lastAt: [M, num],
  description: [A, str(2000)],
});
const AGENT = shape({
  key: [M, S], sessionId: [M, S], pid: [M, num], live: [M, bool], kind: [M, S], project: [M, S],
  model: [M, S], version: [M, S], status: [M, oneOf(STATUSES, 'offline')], rawStatus: [M, S], now: [M, now],
  outTokens: [M, count], cost: [M, num], context: [M, count], toolCount: [M, count],
  startedAt: [M, num], lastAt: [M, num], job: [M, JOB], subagents: [M, list(SUB, 100)],
  name: [A, S], title: [A, str(2000)], branch: [A, S], todos: [A, list(TODO, 100)], prs: [A, list(PR, 50)],
  cwd: [F, str(1000)], lastSay: [F, SAY], lastPrompt: [F, str(400)],
});

const COMMON = { id: [M, S], t: [M, num], kind: [M, S] };
// Notes can carry an API error or a background task's summary; below full only fixed labels go out.
const FIXED_NOTES = ['Context compacted', 'Interrupted by user'];
const noteText = (v, level) => (level >= F ? str(400)(v) : FIXED_NOTES.includes(v) ? v : 'Note (details not shared)');
const EVENT = {
  tool: [M, shape({
    ...COMMON, toolId: [M, S], name: [M, S], label: [M, S], cat: [M, oneOf(CATS, 'other')],
    summary: [A, str(200)], detail: [F, str(1600)],
  })],
  result: [M, shape({ ...COMMON, toolId: [M, S], ok: [M, bool], ms: [M, num], text: [F, str(1000)] })],
  note: [A, shape({ ...COMMON, text: [A, noteText] })],
  pr: [A, shape({ ...COMMON, url: [A, str(500)], text: [A, S] })],
  say: [F, shape({ ...COMMON, text: [F, str(2600)] })],
  prompt: [F, shape({ ...COMMON, text: [F, str(1600)] })],
};
const OTHER = shape({
  id: [M, S], label: [M, S], pids: [M, list(num, 1000)], memory: [M, count], startedAt: [M, num], cmd: [F, S],
});

export function shareAgents(agents, level) {
  const r = rank(level);
  return list(AGENT, 500)(agents, r).map((a) => {
    if (r < A) a.name = a.project || `session ${a.sessionId.slice(0, 8)}`;
    return a;
  });
}

export function shareEvents(events, level) {
  const r = rank(level);
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    const rule = EVENT[e?.kind];
    if (rule && r >= rule[0]) out.push(rule[1](e, r));
  }
  return out;
}

// { key: events[] } -> the same, without keys left with no events.
export function shareAllEvents(byKey, level) {
  const out = {};
  for (const [k, evs] of Object.entries(byKey || {})) {
    const shared = shareEvents(evs, level);
    if (shared.length) out[k] = shared;
  }
  return out;
}

export const shareOthers = (others, level) => list(OTHER, 100)(others, rank(level));
