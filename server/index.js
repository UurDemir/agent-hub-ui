import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ClaudeCollector, DIR } from './claude.js';
import { MAX_MESSAGE, sendToSession } from './messaging.js';
import { ProcessScanner } from './processes.js';
import { ProjectCatalog } from './projects.js';

const PORT = Number(process.env.PORT) || 4317;
// Transcripts contain your code and prompts: only listen on this machine.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
// Blocks DNS rebinding: a web page whose domain resolves to 127.0.0.1 could otherwise read the API.
// Enforced for any loopback bind; binding elsewhere (HOST=0.0.0.0) is an explicit opt-out.
const LOOPBACK = HOST === 'localhost' || /^127\./.test(HOST) || /^(::1|::ffff:127\.[\d.]+)$/i.test(HOST);
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', HOST.includes(':') ? `[${HOST}]` : HOST]
  .map((h) => `${h}:${PORT}`.toLowerCase()));
const hostAllowed = (req) => !LOOPBACK || ALLOWED_HOSTS.has(String(req.headers.host).toLowerCase());
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

const claude = new ClaudeCollector();
const procs = new ProcessScanner();
const catalog = new ProjectCatalog(claude);
const clients = new Set();

const frame = (type, json) => `event: ${type}\ndata: ${json}\n\n`;
const broadcast = (type, json) => { for (const res of clients) res.write(frame(type, json)); };

let lastAgents = '';
claude.on('tick', () => {
  const json = JSON.stringify(claude.snapshot());
  if (json !== lastAgents) { lastAgents = json; broadcast('agents', json); }
});
claude.on('events', (key, events) => broadcast('events', JSON.stringify({ key, events })));
procs.on('update', (others) => broadcast('others', JSON.stringify(others)));

function stream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(frame('init', JSON.stringify({
    host: os.hostname(),
    send: SEND_EPOCH,
    agents: claude.snapshot(),
    others: procs.others,
    events: claude.allEvents(200),
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

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Message too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Checks shared by the messaging endpoints; returns true if it already answered.
function refuseSend(req, res) {
  let why;
  if (req.method !== 'POST') why = [405, 'Use POST'];
  else if (!SEND_ON) why = [403, 'Sending is off. Start Agent Hub with --allow-send.'];
  else if (req.headers.origin !== `http://${req.headers.host}`) why = [403, 'Bad origin'];
  else if (!String(req.headers['content-type']).startsWith('application/json')) why = [415, 'Expected JSON'];
  if (why) json(res, why[0], { error: why[1] });
  return !!why;
}

async function unlock(req, res) {
  if (refuseSend(req, res)) return;
  let body;
  try { body = JSON.parse(await readBody(req, 1024)); } catch { return json(res, 400, { error: 'Bad request' }); }
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
  try { body = JSON.parse(await readBody(req, MAX_MESSAGE * 4 + 1024)); } catch { return json(res, 400, { error: 'Bad request' }); }
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

function handle(req, res) {
  if (!hostAllowed(req)) { res.writeHead(403).end('Forbidden host'); return; }
  // No framing by other sites (clickjacking the message box).
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  if (req.url === '/api/stream') return stream(req, res);
  if (req.url === '/api/send' || req.url === '/api/send/unlock') {
    return (req.url === '/api/send' ? send : unlock)(req, res)
      .catch((e) => { if (!res.headersSent) json(res, 400, { error: e.message }); });
  }
  if (req.url.startsWith('/api/projects')) return projects(req, res);
  if (req.url === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ agents: claude.snapshot(), others: procs.others }));
  }
  serveStatic(req, res);
}

// A bad request must never take the dashboard down for everyone.
const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (e) {
    console.error('[http]', e.message);
    if (!res.headersSent) res.writeHead(400).end('Bad request');
  }
});

const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Agent Hub may already be running at ${url}; otherwise pick another port with --port.`);
  else console.error(`Agent Hub could not start: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  claude.start();
  procs.start();
  console.log(`Agent Hub running at ${url}  (Ctrl+C to stop)`);
  if (SEND_REQUESTED && !SEND_ON) console.warn('--allow-send is ignored unless Agent Hub listens on a loopback address.');
  const open = process.argv.includes('--open') || process.env.AGENT_HUB_OPEN === '1';
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
