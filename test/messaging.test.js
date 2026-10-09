import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { keyHash, readPeerToken, sendToSession } from '../server/messaging.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-msg-'));
const sockPath = (dir) => (process.platform === 'win32'
  ? `\\\\.\\pipe\\LOCAL\\agent-hub-test-${randomBytes(8).toString('hex')}`
  : path.join(dir, 's.sock'));

test('keyHash matches Claude Code key file names', () => {
  // Real pair: a session's messagingSocketPath and the hash in its .key file name.
  assert.equal(
    keyHash('\\\\.\\pipe\\LOCAL\\cc-msg-a92ff276f947aeaab2efe7baa16a3e13', 'win32').slice(0, 16),
    'a9ad1499449af0ac',
  );
});

test('readPeerToken finds the key for a socket and rejects malformed ones', () => {
  const dir = tmp();
  const sock = sockPath(dir);
  const token = randomBytes(16).toString('hex');
  assert.equal(readPeerToken(dir, 42, sock), null);
  fs.writeFileSync(path.join(dir, `42.${keyHash(sock)}.key`), JSON.stringify({ peerToken: 'nope' }));
  assert.equal(readPeerToken(dir, 42, sock), null);
  fs.writeFileSync(path.join(dir, `42.${keyHash(sock)}.key`), JSON.stringify({ peerToken: token }));
  assert.equal(readPeerToken(dir, 42, sock), token);
  assert.equal(readPeerToken(dir, 42, sock + 'x'), null);
});

test('sendToSession authenticates, then sends one user message', async () => {
  const dir = tmp();
  const sock = sockPath(dir);
  const token = randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, `7.${keyHash(sock)}.key`), JSON.stringify({ peerToken: token }));
  let data = '';
  const got = new Promise((resolve) => {
    const server = net.createServer((c) => {
      c.on('data', (d) => { data += d; });
      c.on('end', () => { server.close(); resolve(data); });
    });
    server.listen(sock);
  });
  await new Promise((r) => setTimeout(r, 50));
  await sendToSession(dir, { pid: 7, sessionId: 'abc', messagingSocketPath: sock }, 'hello\nthere');
  const lines = (await got).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { type: 'auth', token });
  assert.equal(lines[1].type, 'user');
  assert.equal(lines[1].session_id, 'abc');
  assert.deepEqual(lines[1].message, { role: 'user', content: 'hello\nthere' });
});

test('sendToSession fails cleanly without a socket or key', async () => {
  const dir = tmp();
  await assert.rejects(sendToSession(dir, { pid: 1, sessionId: 'x' }, 'hi'), /no messaging socket/);
  await assert.rejects(sendToSession(dir, { pid: 1, sessionId: 'x', messagingSocketPath: sockPath(dir) }, 'hi'), /No messaging key/);
});
