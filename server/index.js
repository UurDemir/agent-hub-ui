import http from 'node:http';
import https from 'node:https';
import crypto, { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ClaudeCollector, DIR } from './claude.js';
import { MAX_MESSAGE, sendToSession } from './messaging.js';
import { ProcessScanner } from './processes.js';
import { ProjectCatalog } from './projects.js';
import { Hub, Keyring } from './hub.js';
import { Reporter, ingestUrl } from './reporter.js';

const env = process.env;
const die = (msg) => { console.error(msg); process.exit(1); };
const PORT = env.PORT === '0' ? 0 : Number(env.PORT) || 4317;
// Transcripts contain your code and prompts: only listen on this machine.
const HOST = env.HOST || '127.0.0.1';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const isLoopback = (h) => h === 'localhost' || /^127(\.\d{1,3}){3}$/.test(h) || /^(::1|::ffff:127\.[\d.]+)$/i.test(h);
// Blocks DNS rebinding: a web page whose domain resolves to 127.0.0.1 could otherwise read the API.
// Enforced for any loopback bind; binding elsewhere (HOST=0.0.0.0) is an explicit opt-out.
// --allowed-host adds names a reverse proxy in front of the dashboard sends.
const LOOPBACK = isLoopback(HOST);
const EXTRA_HOSTS = (env.AGENT_HUB_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
let allowedHosts = new Set();
let url = ''; // the dashboard's address, once it listens
const hostAllowed = (req) => !LOOPBACK || allowedHosts.has(String(req.headers.host).toLowerCase());
// Someone viewing through a reverse proxy (--allowed-host) or over the network rather than on this PC.
// They see agents, but not this PC's Claude setup on the Projects page (CLAUDE.md, MCP, hooks…).
const remoteViewer = (req) => !LOOPBACK || EXTRA_HOSTS.includes(String(req.headers.host).toLowerCase());
const decode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };
// Sending messages to sessions is opt-in (--allow-send) and only on a loopback bind. Nothing that any
// local program can fetch hands out a send token: the CLI opens (or prints) a one-use link carrying
// an unlock code in its #fragment, and the tab trades that code for its own token at
// /api/send/unlock. Each use prints a fresh link for another tab. Sends carry the token in a header.
const SEND_REQUESTED = process.env.AGENT_HUB_ALLOW_SEND === '1' || process.argv.includes('--allow-send');
const SEND_ON = SEND_REQUESTED && LOOPBACK;
const SEND_EPOCH = SEND_ON ? randomBytes(8).toString('hex') : null; // not secret: lets a tab drop a token from an earlier run
const sendTokens = new Set();
let unlockCode = null;
const secretEqual = (got, want) => {
  const a = Buffer.from(String(got ?? ''));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};
const tokenOk = (t) => [...sendTokens].some((s) => secretEqual(t, s));
function unlockLink() {
  unlockCode = randomBytes(32).toString('hex');
  return `${url}/#send=${unlockCode}`;
}
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const readSecret = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { return die(`Can't read ${file}: ${e.message}`); } };

/* ---------- configuration ---------- */

const HEADLESS = env.AGENT_HUB_HEADLESS === '1';
const HUB = env.AGENT_HUB_HUB === '1';
const VIEWER_PASSWORD = env.AGENT_HUB_VIEWER_PASSWORD || '';
const viewerHash = VIEWER_PASSWORD && digest(VIEWER_PASSWORD);

if (HUB && !env.AGENT_HUB_KEYS) die('--hub needs --hub-keys <file>: the machines allowed to report. Create entries with --new-key <name>.');
if (HUB && !LOOPBACK && !VIEWER_PASSWORD) {
  die(`--hub shows every reporting machine's activity, so the dashboard can't listen on ${HOST} without a login.
Keep --host 127.0.0.1 and put it behind your SSO reverse proxy (pass the public name with --allowed-host),
or set --viewer-password.`);
}
if (HEADLESS && !env.AGENT_HUB_REPORT_TO) die('--headless only makes sense with --report-to <hub url>.');

let keyring = null;
if (HUB) {
  try { keyring = new Keyring(env.AGENT_HUB_KEYS); } catch (e) { die(`--hub-keys: ${e.message}`); }
}

let reportUrl = null;
if (env.AGENT_HUB_REPORT_TO) {
  try { reportUrl = ingestUrl(env.AGENT_HUB_REPORT_TO, env.AGENT_HUB_ALLOW_HTTP === '1'); } catch (e) { die(e.message); }
}

/* ---------- data ---------- */

const claude = new ClaudeCollector();
const procs = new ProcessScanner();
const catalog = new ProjectCatalog(claude);
const hub = HUB ? new Hub() : null;
const clients = new Set();
let reporter = null;
if (reportUrl) {
  try {
    reporter = new Reporter({
      url: reportUrl,
      key: env.AGENT_HUB_REPORT_KEY || (env.AGENT_HUB_REPORT_KEY_FILE ? readSecret(env.AGENT_HUB_REPORT_KEY_FILE) : ''),
      share: env.AGENT_HUB_SHARE || 'metadata',
      collector: claude, procs, version: VERSION,
    });
  } catch (e) { die(e.message); }
}

const agents = () => (hub ? [...claude.snapshot(), ...hub.snapshot()] : claude.snapshot());
const others = () => (hub ? [...procs.others, ...hub.others()] : procs.others);
const allEvents = (n) => (hub ? { ...claude.allEvents(n), ...hub.allEvents(n) } : claude.allEvents(n));
// In hub mode: this PC first (its agents keep their plain keys), then the reporting machines.
const machines = () => (hub ? [{ id: '@local', name: os.hostname(), local: true, online: true }, ...hub.list()] : null);

const frame = (type, json) => `event: ${type}\ndata: ${json}\n\n`;
const broadcast = (type, json) => { for (const res of clients) res.write(frame(type, json)); };

let lastAgents = '';
let lastMachines = '';
let agentsTimer = null;
function pushAgents() {
  agentsTimer = null;
  const json = JSON.stringify(agents());
  if (json !== lastAgents) { lastAgents = json; broadcast('agents', json); }
  if (hub) {
    const m = JSON.stringify(machines());
    if (m !== lastMachines) { lastMachines = m; broadcast('machines', m); }
  }
}
// Reports from many machines arrive all the time; send at most a few snapshots a second.
const schedulePush = () => { agentsTimer ??= setTimeout(pushAgents, 250); };

claude.on('tick', pushAgents);
claude.on('events', (key, events) => broadcast('events', JSON.stringify({ key, events })));
procs.on('update', () => broadcast('others', JSON.stringify(others())));
hub?.on('agents', schedulePush);
hub?.on('events', (key, events) => broadcast('events', JSON.stringify({ key, events })));
hub?.on('others', () => broadcast('others', JSON.stringify(others())));
reporter?.on('status', (s) => broadcast('reporting', JSON.stringify(s)));

/* ---------- dashboard ---------- */

function stream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // let nginx pass events through as they happen
  });
  res.write(frame('init', JSON.stringify({
    host: os.hostname(),
    send: remoteViewer(req) ? null : SEND_EPOCH,
    agents: agents(),
    others: others(),
    events: allEvents(200),
    machines: machines(),
    reporting: reporter?.status || null,
    projects: !remoteViewer(req),
  })));
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  const rel = url.pathname === '/' ? 'index.html' : decode(url.pathname)?.replace(/^\/+/, '');
  if (rel == null) { res.writeHead(400).end('Bad request'); return; }
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(body));
}

async function projects(req, res) {
  const id = decode(new URL(req.url, 'http://x').pathname.slice('/api/projects'.length).replace(/^\/+/, ''));
  if (id == null) return json(res, 400, { error: 'Bad request' });
  try {
    if (!id) return json(res, 200, catalog.list());
    const d = await catalog.detail(id);
    return d ? json(res, 200, d) : json(res, 404, { error: 'Unknown project' });
  } catch (e) {
    console.error('[projects]', e);
    return json(res, 500, { error: e.message });
  }
}

// Checks shared by the messaging endpoints; returns true if it already answered.
function refuseSend(req, res) {
  let why;
  if (req.method !== 'POST') why = [405, 'Use POST'];
  else if (!SEND_ON) why = [403, 'Sending is off. Start Agent Hub with --allow-send.'];
  else if (remoteViewer(req)) why = [403, 'Sending only works from a browser on this PC.'];
  else if (req.headers.origin !== `http://${req.headers.host}`) why = [403, 'Bad origin'];
  else if (!String(req.headers['content-type']).startsWith('application/json')) why = [415, 'Expected JSON'];
  if (why) json(res, why[0], { error: why[1] });
  return !!why;
}

async function unlock(req, res) {
  if (refuseSend(req, res)) return;
  let body;
  try { body = JSON.parse((await readBody(req, 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'Bad request' }); }
  if (!unlockCode || !secretEqual(body?.code, unlockCode)) {
    return json(res, 403, { error: 'This unlock link was already used. Open the newest link Agent Hub printed in its terminal.' });
  }
  const token = randomBytes(32).toString('hex');
  sendTokens.add(token);
  console.log(`Messaging unlocked in a browser tab. To unlock another tab, open: ${unlockLink()}`);
  return json(res, 200, { token, epoch: SEND_EPOCH });
}

async function send(req, res) {
  if (refuseSend(req, res)) return;
  if (!tokenOk(req.headers['x-agent-hub-token'])) return json(res, 403, { error: 'Bad token' });
  let body;
  try { body = JSON.parse((await readBody(req, MAX_MESSAGE * 4 + 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'Bad request' }); }
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return json(res, 400, { error: 'Empty message' });
  if (text.length > MAX_MESSAGE) return json(res, 400, { error: `Messages are limited to ${MAX_MESSAGE} characters` });
  const s = typeof body.key === 'string' ? claude.sessions.get(body.key) : null;
  if (!s?.live || !s.info) return json(res, 404, { error: 'That session is not running' });
  try {
    await sendToSession(DIR.sessions, s.info, text);
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 502, { error: e.message });
  }
}

// --viewer-password: HTTP Basic auth in front of the whole dashboard (any user name).
function viewerAllowed(req) {
  if (!viewerHash) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  return crypto.timingSafeEqual(digest(decoded.slice(decoded.indexOf(':') + 1)), viewerHash);
}

function handle(req, res) {
  if (!hostAllowed(req)) { res.writeHead(403).end('Forbidden host'); return; }
  // No framing by other sites (clickjacking the message box).
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  if (!viewerAllowed(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Agent Hub", charset="UTF-8"' }).end('Login required');
    return;
  }
  if (req.url === '/api/stream') return stream(req, res);
  if (req.url === '/api/send' || req.url === '/api/send/unlock') {
    return (req.url === '/api/send' ? send : unlock)(req, res)
      .catch((e) => { if (!res.headersSent) json(res, 400, { error: e.message }); });
  }
  if (req.url.startsWith('/api/projects')) {
    if (remoteViewer(req)) return json(res, 404, { error: 'The Projects page is only available on this PC itself.' });
    return projects(req, res);
  }
  if (req.url === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ agents: agents(), others: others(), machines: machines() }));
  }
  serveStatic(req, res);
}

/* ---------- hub ingest ---------- */

const MAX_BODY = 16 * 1024 * 1024;      // compressed
const MAX_INFLATED = 32 * 1024 * 1024;
const gunzip = promisify(zlib.gunzip);
const rejectedAt = new Map(); // remote address -> last time a bad key was logged

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function ingest(req, res) {
  if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== '/ingest') return json(res, 404, { error: 'Not found' });
  const entry = keyring.match(/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1]);
  if (!entry) {
    const from = req.socket.remoteAddress;
    if (Date.now() - (rejectedAt.get(from) || 0) > 60e3) {
      if (rejectedAt.size > 1000) rejectedAt.clear();
      rejectedAt.set(from, Date.now());
      console.warn(`[hub] rejected a report with an unknown key from ${from} (logged once a minute)`);
    }
    return json(res, 401, { error: 'Unknown machine key' });
  }
  try {
    let buf = await readBody(req, MAX_BODY);
    if (/gzip/i.test(req.headers['content-encoding'] || '')) buf = await gunzip(buf, { maxOutputLength: MAX_INFLATED });
    const r = hub.ingest(entry, JSON.parse(buf.toString('utf8')));
    return json(res, r.status, r.body);
  } catch (e) {
    return json(res, e.status || 400, { error: e.status ? e.message : 'Unreadable report' });
  }
}

/* ---------- start ---------- */

const listenUrl = (proto, host, port) => `${proto}://${host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host}:${port}`;

function onListenError(what, port) {
  return (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. ${what} may already be running; otherwise pick another port.`);
    else console.error(`${what} could not start: ${e.message}`);
    process.exit(1);
  };
}

claude.start();
procs.start();
reporter?.start();
hub?.start();

if (HUB) {
  const port = env.AGENT_HUB_INGEST_PORT === '0' ? 0 : Number(env.AGENT_HUB_INGEST_PORT) || 4318;
  const host = env.AGENT_HUB_INGEST_HOST || '0.0.0.0';
  const tls = env.AGENT_HUB_TLS_CERT || env.AGENT_HUB_TLS_KEY;
  if (tls && !(env.AGENT_HUB_TLS_CERT && env.AGENT_HUB_TLS_KEY)) die('--tls-cert and --tls-key go together.');
  const handler = (req, res) => ingest(req, res).catch((e) => { console.error('[ingest]', e.message); if (!res.headersSent) json(res, 500, { error: 'Internal error' }); });
  const server = tls
    ? https.createServer({ cert: fs.readFileSync(env.AGENT_HUB_TLS_CERT), key: fs.readFileSync(env.AGENT_HUB_TLS_KEY) }, handler)
    : http.createServer(handler);
  server.requestTimeout = 60e3;
  server.on('error', onListenError('The hub ingest port', port));
  server.listen(port, host, () => {
    const url = listenUrl(tls ? 'https' : 'http', host, server.address().port);
    console.log(`Hub ingest listening at ${url}  (${keyring.entries.length} machine key${keyring.entries.length === 1 ? '' : 's'})`);
    if (!tls && !isLoopback(host)) {
      console.warn('  Warning: no TLS. Machine keys and agent activity cross the network in clear text unless a TLS proxy or VPN carries them.');
    }
  });
}

if (!HEADLESS) {
  // A bad request must never take the dashboard down for everyone.
  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      console.error('[http]', e.message);
      if (!res.headersSent) res.writeHead(400).end('Bad request');
    }
  });
  server.on('error', onListenError('Agent Hub', PORT));
  server.listen(PORT, HOST, () => {
    const port = server.address().port;
    allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', HOST.includes(':') ? `[${HOST}]` : HOST]
      .map((h) => `${h}:${port}`.toLowerCase()).concat(EXTRA_HOSTS));
    url = listenUrl('http', HOST, port);
    console.log(`Agent Hub running at ${url}  (Ctrl+C to stop)`);
    if (!LOOPBACK && VIEWER_PASSWORD) console.warn('  The viewer password is sent in clear text unless a TLS proxy or VPN carries it.');
    if (SEND_REQUESTED && !SEND_ON) console.warn('--allow-send is ignored unless Agent Hub listens on a loopback address.');
    const open = process.argv.includes('--open') || env.AGENT_HUB_OPEN === '1';
    const link = SEND_ON ? unlockLink() : url;
    if (SEND_ON) {
      console.log(open
        ? 'Messaging is on (--allow-send). The tab opened now can send; later tabs need the link printed after it unlocks.'
        : `Messaging is on (--allow-send). Open this one-use link to send from a tab: ${link}`);
    }
    if (open) {
      if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', link]);
      else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [link]);
    }
  });
}
