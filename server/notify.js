// Push notifications (opt-in with --notify <target>): tells a phone or a chat when an agent needs
// you or has finished, on this PC or, on a hub, on any reporting machine. The browser's own
// notifications only work while a dashboard tab is open; these don't need one.
//
// A target is "<type>:<url>":
//   ntfy:https://ntfy.sh/<topic>             (https://user:pass@… for a protected topic)
//   gotify:https://gotify.example/message?token=<app token>
//   discord:https://discord.com/api/webhooks/…
//   slack:https://hooks.slack.com/services/…
//   telegram:<bot token>/<chat id>
//   webhook:https://example/hook             (JSON: { event, title, body, agent, t })
// What a notification says goes through share.js at its own level (--notify-share, default
// metadata): with metadata, an agent is named after its project folder, never its prompt.
import { shareAgents, levelOf } from './share.js';

const KINDS = ['ntfy', 'gotify', 'discord', 'slack', 'telegram', 'webhook'];
export const NOTIFY_EVENTS = ['waiting', 'done', 'machine'];
const PER_KEY_MS = 10e3;    // at most one notification per agent this often
const MAX_PER_MIN = 30;     // and this many in total per minute
const TIMEOUT_MS = 10e3;
const TOOL_NAMES = { codex: 'Codex', openclaw: 'OpenClaw', gemini: 'Gemini CLI', opencode: 'opencode', copilot: 'Copilot CLI' };

// "<type>:<url>" -> { kind, url, headers, label } (label: what logs may show; never the secret part)
// This machine or the home network (private IPv4, .local / .lan / .home.arpa names).
export const isLocalHost = (h) => {
  h = String(h).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h) || /^10(\.\d{1,3}){3}$/.test(h)
    || /^192\.168(\.\d{1,3}){2}$/.test(h) || /^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/.test(h)
    || /\.(local|lan|home\.arpa)$/.test(h);
};

export function parseTarget(spec, { allowHttp = false } = {}) {
  const s = String(spec || '').trim();
  const i = s.indexOf(':');
  const kind = s.slice(0, i).toLowerCase();
  const rest = s.slice(i + 1);
  if (i < 0 || !KINDS.includes(kind)) throw new Error(`--notify: start the target with one of ${KINDS.map((k) => `${k}:`).join(', ')} (this one has an unknown type; its value isn't shown because it may hold a token)`);
  if (kind === 'telegram') {
    const m = /^([0-9]+:[A-Za-z0-9_-]+)\/(-?[0-9]+|@[A-Za-z0-9_]+)$/.exec(rest);
    if (!m) throw new Error('--notify telegram: use telegram:<bot token>/<chat id>');
    return { kind, url: new URL(`https://api.telegram.org/bot${m[1]}/sendMessage`), chat: m[2], headers: {}, label: 'telegram' };
  }
  let url;
  try { url = new URL(rest); } catch { throw new Error(`--notify ${kind}: not a URL`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`--notify ${kind}: the URL must be http(s)`);
  // Like --report-to: no tokens or agent names in clear text off this machine unless asked for.
  if (url.protocol === 'http:' && !isLocalHost(url.hostname) && !allowHttp) {
    throw new Error(`--notify ${kind}: refusing plain http to ${url.host}. Use https://, or --allow-http if the network is already encrypted (VPN, Tailscale, WireGuard).`);
  }
  const headers = {};
  if (url.username || url.password) { // fetch refuses credentials in a URL
    headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`;
    url.username = ''; url.password = '';
  }
  return { kind, url, headers, label: `${kind} ${url.host}` };
}

// One notification as the request each service expects.
export function request(target, n) {
  const json = (body) => ({ method: 'POST', headers: { ...target.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = `${n.title}${n.body ? `\n${n.body}` : ''}`;
  switch (target.kind) {
    case 'ntfy':
      return { method: 'POST', body: n.body || n.title, headers: {
        ...target.headers, Title: n.title.replace(/[^\x20-\x7e]/g, '?'), Tags: n.event === 'waiting' ? 'bell' : n.event === 'done' ? 'white_check_mark' : 'electric_plug',
        Priority: n.event === 'waiting' ? '4' : '3',
      } };
    case 'gotify': return json({ title: n.title, message: n.body || n.title, priority: n.event === 'waiting' ? 7 : 4 });
    case 'discord': return json({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } });
    // Slack reads <!channel>, <@user> and links from text: escape them so a name can't ping anyone.
    case 'slack': return json({ text: text.slice(0, 3000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') });
    case 'telegram': return json({ chat_id: target.chat, text: text.slice(0, 3500), disable_web_page_preview: true });
    default: return json({ event: n.event, title: n.title, body: n.body, agent: n.agent, t: n.t });
  }
}

export class Notifier {
  // send(target, init): the HTTP call, replaceable in tests.
  constructor({ targets, share = 'metadata', on = ['waiting', 'done'], minSeconds = 30, host = '', send, allowHttp = false } = {}) {
    if (!levelOf(share)) throw new Error(`--notify-share must be metadata, activity or full (got "${share}")`);
    const bad = on.filter((e) => !NOTIFY_EVENTS.includes(e));
    if (bad.length) throw new Error(`--notify-on: unknown event ${bad.join(', ')} (use ${NOTIFY_EVENTS.join(', ')})`);
    this.targets = targets.map((t) => parseTarget(t, { allowHttp }));
    this.share = share;
    this.on = new Set(on);
    this.minMs = Math.max(0, minSeconds) * 1000;
    this.host = host;
    // No redirects: a redirect would carry the token (and the message) to wherever it points.
    this.send = send || ((t, init) => fetch(t.url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }));
    this.prev = null;       // key -> { status, workingSince }
    this.machines = null;   // machine id -> online
    this.lastByKey = new Map();
    this.sent = [];         // timestamps in the last minute
    this.failedAt = new Map();
  }

  // Called with each agents snapshot; the first one only sets the baseline.
  check(agents, machines = null, now = Date.now()) {
    const list = shareAgents(agents, this.share);
    // The hub adds `machine` after its own share pass; keep it (it's the key entry's name).
    const machineOf = new Map(agents.map((a) => [a?.key, typeof a?.machine === 'string' ? a.machine : '']));
    const next = new Map();
    const out = [];
    for (const a of list) {
      const was = this.prev?.get(a.key);
      const workingSince = a.status === 'working' ? (was?.status === 'working' ? was.workingSince : now) : 0;
      next.set(a.key, { status: a.status, workingSince });
      if (!this.prev || !was || was.status === a.status) continue;
      if (a.status === 'waiting' && this.on.has('waiting')) out.push(this.message('waiting', a, machineOf.get(a.key), now));
      else if (a.status === 'idle' && was.status === 'working' && this.on.has('done') && now - was.workingSince >= this.minMs) {
        out.push(this.message('done', a, machineOf.get(a.key), now));
      }
    }
    this.prev = next;
    if (machines) {
      const online = new Map(machines.filter((m) => !m.local).map((m) => [m.id, m.online]));
      if (this.machines && this.on.has('machine')) {
        for (const [id, on] of online) {
          if (this.machines.has(id) && this.machines.get(id) !== on) {
            out.push({ event: 'machine', key: `machine:${id}`, title: `${id} ${on ? 'reconnected' : 'disconnected'}`, body: on ? '' : 'Its agents show as ended until it reports again.', agent: null, t: now });
          }
        }
      }
      this.machines = online;
    }
    for (const n of out) this.deliver(n, now);
    return out;
  }

  message(event, a, machine, now) {
    const tool = TOOL_NAMES[a.kind] || 'Claude Code';
    const where = [machine, a.project].filter(Boolean).join(' · ');
    const title = event === 'waiting' ? `${a.name} needs you` : `${a.name} finished`;
    // The summary is only present at the levels that allow it (share.js already applied).
    const detail = this.share === 'full' ? a.lastSay?.text : a.now?.summary;
    return {
      event, key: a.key, title: title.slice(0, 120), t: now,
      body: [`${tool}${where ? ` · ${where}` : ''}`, detail].filter(Boolean).join('\n').slice(0, 600),
      agent: { key: a.key, name: a.name, kind: a.kind || 'claude', machine: machine || this.host, project: a.project, status: a.status },
    };
  }

  deliver(n, now) {
    if (this.lastByKey.has(n.key) && now - this.lastByKey.get(n.key) < PER_KEY_MS) return;
    this.sent = this.sent.filter((t) => now - t < 60e3);
    if (this.sent.length >= MAX_PER_MIN) return;
    this.lastByKey.set(n.key, now);
    if (this.lastByKey.size > 2000) this.lastByKey.clear();
    this.sent.push(now);
    for (const t of this.targets) {
      Promise.resolve()
        .then(() => this.send(t, request(t, n)))
        .then((res) => { if (res && res.ok === false) throw new Error(`HTTP ${res.status}`); })
        .catch((e) => {
          if (this.failedAt.has(t.label) && now - this.failedAt.get(t.label) < 60e3) return;
          this.failedAt.set(t.label, now);
          console.error(`[notify] ${t.label}: ${e.message}`); // the label never holds a token
        });
    }
  }
}
