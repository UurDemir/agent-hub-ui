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
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
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

function projects(req, res) {
  const id = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice('/api/projects'.length).replace(/^\/+/, ''));
  try {
    if (!id) return json(res, 200, catalog.list());
    const d = catalog.detail(id);
    return d ? json(res, 200, d) : json(res, 404, { error: 'Unknown project' });
  } catch (e) {
    console.error('[projects]', e);
    return json(res, 500, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/stream') return stream(req, res);
  if (req.url.startsWith('/api/projects')) return projects(req, res);
  if (req.url === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ agents: claude.snapshot(), others: procs.others }));
  }
  serveStatic(req, res);
});

claude.start();
procs.start();
server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`Agent Hub running at ${url}`);
  if (process.argv.includes('--open')) {
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
    else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  }
});
