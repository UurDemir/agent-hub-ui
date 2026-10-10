// End to end: a hub and a headless reporter as real processes, each with its own fake ~/.claude.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newMachineKey } from '../server/hub.js';
import { ingestUrl } from '../server/reporter.js';

const SERVER = fileURLToPath(new URL('../server/index.js', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-remote-'));
const children = [];
after(() => {
  for (const c of children) c.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function start(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.log = '';
  child.stdout.on('data', (d) => { child.log += d; });
  child.stderr.on('data', (d) => { child.log += d; });
  return child;
}

async function waitFor(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// The SSE init event: the full snapshot a browser gets.
async function streamInit(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(/^data: (.*)$/m.exec(text)[1]);
}

test('a reporter sends only what its sharing level allows, and the hub shows it under the machine name', async () => {
  const hubHome = path.join(tmp, 'hub-claude');
  const pcHome = path.join(tmp, 'pc-claude');
  fs.mkdirSync(hubHome);
  const project = path.join(pcHome, 'projects', '-home-dev-demo-app');
  fs.mkdirSync(project, { recursive: true });
  const t = (s) => new Date(Date.now() - 60e3 + s * 1000).toISOString();
  const records = [
    { type: 'user', timestamp: t(1), uuid: 'u1', cwd: '/home/dev/demo-app', message: { role: 'user', content: 'Please fix the hidden bug' } },
    { type: 'assistant', timestamp: t(2), uuid: 'a1', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'text', text: 'Sure, looking now' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat private.txt', description: 'Read the private file' } }] } },
    { type: 'user', timestamp: t(3), uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'TOPSECRET' }] } },
  ];
  fs.writeFileSync(path.join(project, '11111111-2222-3333-4444-555555555555.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const { key, entry } = newMachineKey('dev-laptop');
  const keys = path.join(tmp, 'keys.json');
  fs.writeFileSync(keys, JSON.stringify({ machines: [entry] }));

  const hub = start({ CLAUDE_CONFIG_DIR: hubHome, PORT: '0', AGENT_HUB_HUB: '1', AGENT_HUB_KEYS: keys, AGENT_HUB_ALLOWED_HOSTS: 'hub.test', AGENT_HUB_ALLOW_SEND: '1', AGENT_HUB_INGEST_PORT: '0', AGENT_HUB_INGEST_HOST: '127.0.0.1' });
  const ports = await waitFor(() => {
    const ingest = /Hub ingest listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(hub.log)?.[1];
    const web = /Agent Hub running at http:\/\/127\.0\.0\.1:(\d+)/.exec(hub.log)?.[1];
    return ingest && web && { ingest, web };
  }, `the hub to start\n${hub.log}`);

  const bad = await fetch(`http://127.0.0.1:${ports.ingest}/ingest`, { method: 'POST', headers: { Authorization: 'Bearer ahk_wrong' }, body: '{}' });
  assert.equal(bad.status, 401);

  const pc = start({
    CLAUDE_CONFIG_DIR: pcHome, AGENT_HUB_HEADLESS: '1', AGENT_HUB_SHARE: 'metadata',
    AGENT_HUB_REPORT_TO: `http://127.0.0.1:${ports.ingest}`, AGENT_HUB_REPORT_KEY: key,
  });
  const d = await waitFor(async () => {
    const r = await (await fetch(`http://127.0.0.1:${ports.web}/api/agents`)).json();
    return r.agents.some((a) => a.remote) && r;
  }, `the reporter's agent on the hub\n${pc.log}\n${hub.log}`);

  const a = d.agents.find((x) => x.remote);
  assert.equal(a.key, 'dev-laptop:11111111-2222-3333-4444-555555555555');
  assert.equal(a.machine, 'dev-laptop');
  assert.equal(a.share, 'metadata');
  assert.equal(a.project, 'demo-app');
  assert.equal(a.toolCount, 1);
  assert.deepEqual(d.machines.map((m) => [m.id, m.online]), [['@local', true], ['dev-laptop', true]]);

  const init = await streamInit(ports.web);
  const events = init.events[a.key];
  assert.deepEqual(events.map((e) => e.kind), ['tool', 'result']);
  assert.equal(events[0].summary, undefined);
  assert.equal(events[1].ok, true);
  assert.equal(events[1].text, undefined);
  const all = JSON.stringify(init);
  for (const secret of ['Please fix', 'Sure, looking', 'cat private', 'Read the private', 'TOPSECRET', '/home/dev']) {
    assert.equal(all.includes(secret), false, `"${secret}" reached the hub`);
  }
  // A viewer coming through the proxy name sees agents but not this PC's Claude setup.
  const viaProxy = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: ports.web, path: p, headers: { Host: 'hub.test' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(await viaProxy('/api/agents'), 200);
  assert.equal(await viaProxy('/api/projects'), 404);
  assert.equal(await viaProxy('/api/projects/user'), 404);
  assert.equal((await fetch(`http://127.0.0.1:${ports.web}/api/projects`)).status, 200);
  // …and can't message this PC's sessions, even through a plain-http proxy that keeps Origin and Host in line.
  const unlock = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ports.web, path: '/api/send/unlock', method: 'POST',
      headers: { Host: 'hub.test', Origin: 'http://hub.test', 'Content-Type': 'application/json' } }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
    req.end('{"code":"x"}');
  });
  assert.equal(unlock.status, 403);
  assert.match(unlock.body, /only works from a browser on this PC/);

  assert.match(pc.log, /Reporting this machine's agents to http:\/\/127\.0\.0\.1:\d+ \(sharing: metadata\)/);
});

test('only a real loopback address counts as this machine for plain http', () => {
  assert.equal(ingestUrl('http://127.0.0.1:4318').href, 'http://127.0.0.1:4318/ingest');
  assert.equal(ingestUrl('https://hub.example.com/agent-hub').href, 'https://hub.example.com/agent-hub/ingest');
  assert.throws(() => ingestUrl('http://127.evil.example.com:4318'), /plain http/);
  assert.equal(ingestUrl('http://127.evil.example.com', true).protocol, 'http:');
  assert.throws(() => ingestUrl('https://user:pw@hub.example.com'), /credentials/);
});

test('the reporter refuses plain http to another machine', async () => {
  const child = start({ AGENT_HUB_HEADLESS: '1', AGENT_HUB_REPORT_TO: 'http://hub.example.com:4318', AGENT_HUB_REPORT_KEY: 'k' });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 1);
  assert.match(child.log, /Refusing to send transcripts over plain http/);
});

test('a hub refuses a network-facing dashboard without a login', async () => {
  const keys = path.join(tmp, 'empty-keys.json');
  fs.writeFileSync(keys, '{"machines":[]}');
  const child = start({ PORT: '0', HOST: '0.0.0.0', AGENT_HUB_HUB: '1', AGENT_HUB_KEYS: keys, AGENT_HUB_INGEST_PORT: '0' });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 1);
  assert.match(child.log, /can't listen on 0\.0\.0\.0 without a login/);
});
