import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.js');

// Starts a real server with --allow-send against an empty Claude config dir and collects its output.
function start() {
  const port = 41000 + Math.floor(Math.random() * 8000);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AGENT_HUB_ALLOW_SEND: '1', AGENT_HUB_OPEN: '',
      CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-send-')) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const links = async (n) => {
    for (let i = 0; i < 100; i++) {
      const found = [...out.matchAll(/#send=([0-9a-f]{64})/g)].map((m) => m[1]);
      if (found.length >= n) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no unlock link in output:\n${out}`);
  };
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body, headers = {}) => fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { child, base, links, post };
}

test('--allow-send: a one-use link unlocks a tab, and nothing else hands out a token', async (t) => {
  const s = start();
  t.after(() => s.child.kill());
  const [code] = await s.links(1);

  // The stream says messaging is on but carries no token.
  const ac = new AbortController();
  const r = await fetch(`${s.base}/api/stream`, { signal: ac.signal });
  const reader = r.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  const init = JSON.parse(text.match(/data: (.*)\n/)[1]);
  assert.match(init.send, /^[0-9a-f]{16}$/);
  assert.ok(!text.includes(code));
  assert.equal(r.headers.get('x-frame-options'), 'DENY');

  assert.equal((await s.post('/api/send/unlock', { code }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await s.post('/api/send/unlock', { code: '0'.repeat(64) })).status, 403);
  const ok = await s.post('/api/send/unlock', { code });
  assert.equal(ok.status, 200);
  assert.match(ok.body.token, /^[0-9a-f]{64}$/);
  assert.equal(ok.body.epoch, init.send);
  assert.equal((await s.post('/api/send/unlock', { code })).status, 403, 'a code works once');

  // Using a link prints a fresh one for the next tab.
  const [, next] = await s.links(2);
  assert.notEqual(next, code);

  assert.equal((await s.post('/api/send', { key: 'x', text: 'hi' })).status, 403);
  assert.equal((await s.post('/api/send', { key: 'x', text: 'hi' }, { 'X-Agent-Hub-Token': 'é'.repeat(64) })).status, 403);
  // With the token the request gets past every check and fails only because the session doesn't exist.
  assert.equal((await s.post('/api/send', { key: 'x', text: 'hi' }, { 'X-Agent-Hub-Token': ok.body.token })).status, 404);
});
