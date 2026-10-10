import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub, Keyring, newMachineKey, PROTOCOL } from '../server/hub.js';

const entry = { name: 'pc-1', share: 'full' };
const agent = (over = {}) => ({
  key: 's1', sessionId: 's1', live: true, status: 'working', project: 'app', cwd: '/w/app', toolCount: 1,
  subagents: [{ key: 's1/a1', agentId: 'a1', type: 'Explore', status: 'working' }, { key: 'other/a2', agentId: 'a2' }],
  ...over,
});
const tool = { id: 'e1', t: 1, kind: 'tool', toolId: 't1', name: 'Bash', label: 'Bash', cat: 'run', summary: 'ls', detail: 'ls -la' };
const report = (over = {}) => ({ v: PROTOCOL, instance: 'i1', seq: 1, share: 'full', ...over });
const init = { agents: [agent()], others: [{ id: 'cursor', label: 'Cursor', pids: [1] }], events: { s1: [tool], 's1/a1': [], gone: [tool] } };

test('a full snapshot comes first; keys are prefixed with the machine name', () => {
  const hub = new Hub();
  assert.deepEqual(hub.ingest(entry, report()).body, { ok: true, needInit: true });
  assert.equal(hub.ingest(entry, report({ init })).status, 200);
  const [a] = hub.snapshot();
  assert.equal(a.key, 'pc-1:s1');
  assert.equal(a.machine, 'pc-1');
  assert.equal(a.remote, true);
  // A subagent that doesn't belong to its session is dropped.
  assert.deepEqual(a.subagents.map((s) => s.key), ['pc-1:s1/a1']);
  assert.deepEqual(Object.keys(hub.allEvents(200)), ['pc-1:s1']);
  assert.equal(hub.others()[0].machine, 'pc-1');
  assert.equal(hub.list()[0].live, 1);
});

test('updates apply in order; a gap asks for a new snapshot', () => {
  const hub = new Hub();
  hub.ingest(entry, report({ init }));
  const seen = [];
  hub.on('events', (k, evs) => seen.push([k, evs.length]));
  hub.ingest(entry, report({ seq: 2, events: [{ key: 's1', events: [{ ...tool, id: 'e2' }] }, { key: 'unknown', events: [tool] }] }));
  assert.deepEqual(seen, [['pc-1:s1', 1]]);
  assert.equal(hub.allEvents(200)['pc-1:s1'].length, 2);
  assert.equal(hub.ingest(entry, report({ seq: 5, agents: [] })).body.needInit, true);
  assert.equal(hub.snapshot().length, 1, 'the out-of-order report was not applied');
});

test('the keys file can cap what a machine shares', () => {
  const hub = new Hub();
  hub.ingest({ name: 'pc-2', share: 'metadata' }, report({ init }));
  const [a] = hub.snapshot();
  assert.equal(a.share, 'metadata');
  assert.equal('cwd' in a, false);
  assert.equal('summary' in hub.allEvents(200)['pc-2:s1'][0], false);
});

test('a second reporter on the same key is refused while the first is active', () => {
  const hub = new Hub();
  hub.ingest(entry, report({ init }), 1000);
  assert.equal(hub.ingest(entry, report({ instance: 'i2', init }), 2000).status, 409);
  // Once the first one has gone quiet, a restarted reporter takes over.
  assert.equal(hub.ingest(entry, report({ instance: 'i2', init }), 60000).status, 200);
});

test('a silent machine shows as disconnected, then is forgotten', () => {
  const hub = new Hub();
  hub.ingest(entry, report({ init }), 0);
  hub.sweep(30e3);
  const [a] = hub.snapshot();
  assert.equal(a.live, false);
  assert.equal(a.status, 'offline');
  assert.equal(a.subagents[0].status, 'idle');
  assert.deepEqual(hub.others(), []);
  hub.sweep(4 * 3600e3);
  assert.deepEqual(hub.snapshot(), []);
});

test('bad reports are rejected', () => {
  const hub = new Hub();
  assert.equal(hub.ingest(entry, null).status, 400);
  assert.equal(hub.ingest(entry, report({ v: 99 })).status, 400);
  assert.equal(hub.ingest(entry, report({ seq: 'x' })).status, 400);
});

test('keyring matches hashed keys and reloads when the file changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-keys-'));
  const file = path.join(dir, 'keys.json');
  const a = newMachineKey('laptop-a');
  const b = newMachineKey('laptop-b');
  fs.writeFileSync(file, JSON.stringify({ machines: [a.entry] }));
  const ring = new Keyring(file);
  assert.equal(ring.match(a.key).name, 'laptop-a');
  assert.equal(ring.match(b.key), null);
  assert.equal(ring.match(''), null);
  assert.equal(ring.match(undefined), null);

  fs.writeFileSync(file, JSON.stringify({ machines: [{ ...b.entry, share: 'activity' }] }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  ring.checkedAt = 0;
  assert.equal(ring.match(a.key), null, 'removing an entry revokes the machine');
  assert.equal(ring.match(b.key).share, 'activity');

  fs.writeFileSync(file, '{"machines":[{"name":"bad name","sha256":"00"}]}');
  assert.throws(() => new Keyring(file), /invalid name/);
  assert.throws(() => newMachineKey('a/b'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keyring takes the machines inline, as from $AGENT_HUB_MACHINES', () => {
  const a = newMachineKey('nas-pc');
  const ring = new Keyring(undefined, JSON.stringify({ machines: [{ ...a.entry, share: 'metadata' }] }));
  assert.equal(ring.match(a.key).share, 'metadata');
  assert.equal(ring.match('ahk_wrong'), null);
  assert.throws(() => new Keyring(undefined, '{"machines":{}}'), /AGENT_HUB_MACHINES: expected/);
});
