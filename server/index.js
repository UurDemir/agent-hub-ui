import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ClaudeCollector } from './claude.js';
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

function handle(req, res) {
  if (!hostAllowed(req)) { res.writeHead(403).end('Forbidden host'); return; }
  if (req.url === '/api/stream') return stream(req, res);
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
  if (process.argv.includes('--open') || process.env.AGENT_HUB_OPEN === '1') {
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
    else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  }
});
