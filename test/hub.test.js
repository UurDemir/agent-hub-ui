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

test('sessions a reporter stops listing move to the archive, and History can search them', () => {
  const hub = new Hub();
  hub.ingest(entry, report({ init }));
  hub.ingest(entry, report({ seq: 2, agents: [agent({ key: 's2', sessionId: 's2', subagents: [] })] }));
  assert.deepEqual(hub.snapshot().map((a) => a.key), ['pc-1:s2']);
  const [h] = hub.history();
  assert.equal(h.key, 'pc-1:s1');
  assert.equal(h.machine, 'pc-1');
  assert.equal(h.agent.status, 'offline');
  assert.deepEqual(Object.keys(hub.archived('pc-1:s1').events), ['pc-1:s1']);
  assert.equal(hub.history({ q: 'ls' }).length, 1, 'search looks at what was shared');
  assert.equal(hub.history({ q: 'nothing like this' }).length, 0);
  // A restarted reporter (new instance) keeps the archive.
  hub.ingest(entry, report({ instance: 'i2', seq: 1, init: { agents: [], others: [], events: {} } }), Date.now() + 60e3);
  assert.equal(hub.history().length, 2, 's2 is archived too');
});

test('with a data dir the hub keeps its machines and history across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-data-'));
  const a = new Hub({ dataDir: dir });
  a.ingest(entry, report({ init }));
  a.ingest(entry, report({ seq: 2, agents: [] }));
  a.save();
  assert.ok(fs.existsSync(path.join(dir, 'hub-state.json')));
  const b = new Hub({ dataDir: dir });
  b.load();
  assert.equal(b.list()[0].name, 'pc-1');
  assert.equal(b.list()[0].online, false, 'restored machines wait for their next report');
  assert.equal(b.history()[0].key, 'pc-1:s1');
  assert.equal(b.archived('pc-1:s1').events['pc-1:s1'][0].summary, 'ls');
  // The reporter has to start over with a full snapshot.
  assert.deepEqual(b.ingest(entry, report({ seq: 3 })).body, { ok: true, needInit: true });

  // What's restored goes through share.js again: a tampered file can't add fields or other machines.
  const file = path.join(dir, 'hub-state.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.machines[0].share = 'metadata';
  data.machines[0].archive[0][1].agent.evil = '<script>';
  data.machines[0].archive.push(['other-pc:x', data.machines[0].archive[0][1]]);
  data.machines.push({ name: '../bad', share: 'full', lastSeen: Date.now() });
  fs.writeFileSync(file, JSON.stringify(data));
  const c = new Hub({ dataDir: dir });
  c.load();
  assert.deepEqual(c.list().map((m) => m.name), ['pc-1']);
  assert.deepEqual(c.history().map((h) => h.key), ['pc-1:s1']);
  assert.equal(c.history()[0].agent.evil, undefined);
  assert.equal(c.archived('pc-1:s1').events['pc-1:s1'][0].summary, undefined, 'the stored level applies');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a machine silent for hours moves its sessions to the archive and is forgotten after the retention', () => {
  const hub = new Hub({ retainDays: 1 });
  hub.ingest(entry, report({ init }), 0);
  hub.sweep(4 * 3600e3);
  assert.equal(hub.snapshot().length, 0);
  assert.equal(hub.history().length, 1);
  assert.equal(hub.list().length, 1, 'the machine is still listed, offline');
  hub.sweep(2 * 86400e3);
  assert.equal(hub.list().length, 0);
});

test('lowering a machine in the keys file lowers what the hub already kept from it, archive included', () => {
  const hub = new Hub();
  const full = { name: 'pc-1', share: 'full' };
  hub.ingest(full, report({ init }));
  hub.ingest(full, report({ seq: 2, agents: [agent({ key: 's2', sessionId: 's2', subagents: [] })] }));
  assert.equal(hub.archived('pc-1:s1').events['pc-1:s1'][0].detail, 'ls -la');
  hub.ingest({ name: 'pc-1', share: 'metadata' }, report({ seq: 3 }));
  const x = hub.archived('pc-1:s1');
  assert.equal(x.events['pc-1:s1'][0].detail, undefined);
  assert.equal(x.events['pc-1:s1'][0].summary, undefined);
  assert.equal(x.agent.cwd, undefined);
  assert.equal(x.agent.share, 'metadata');
  assert.equal(hub.snapshot()[0].cwd, undefined);
  assert.equal(hub.list()[0].share, 'metadata');
});

test('a lowered keys-file entry also lowers an offline machine and a restarted reporter', () => {
  let cap = 'full';
  const hub = new Hub({ levelFor: () => cap });
  const full = { name: 'pc-1', share: 'full' };
  hub.ingest(full, report({ init }), 0);
  hub.ingest(full, report({ seq: 2, agents: [] }), 1000);
  cap = 'metadata';
  hub.sweep(60e3); // no report from it since
  assert.equal(hub.archived('pc-1:s1').events['pc-1:s1'][0].detail, undefined);
  assert.equal(hub.others()[0], undefined, 'offline machines list no tools');
  assert.equal(hub.list()[0].share, 'metadata');

  const hub2 = new Hub();
  hub2.ingest(full, report({ init }), 0);
  hub2.ingest(full, report({ seq: 2, agents: [] }), 1000);
  // The reporter restarts (new instance) after the entry was lowered.
  hub2.ingest({ name: 'pc-1', share: 'activity' }, report({ instance: 'i2', seq: 1, init: { agents: [], others: [{ id: 'cursor', label: 'Cursor', pids: [1], cmd: '/opt/cursor --secret' }], events: {} } }), 60e3);
  assert.equal(hub2.archived('pc-1:s1').events['pc-1:s1'][0].detail, undefined);
  assert.equal(hub2.others()[0].cmd, undefined);
});

test('below full, names and summaries from a reporter older than 0.5.1 are treated as free text', () => {
  const hub = new Hub();
  const capped = { name: 'pc-1', share: 'activity' };
  const old = (over) => report({ version: '0.4.1', ...over });
  const a = agent({ name: 'fix the login bug', now: { verb: 'Calling', label: 'slack · post', summary: 'the launch slips', cat: 'mcp', since: 1 } });
  hub.ingest(capped, old({ init: { agents: [a], others: [], events: { s1: [{ ...tool, summary: 'the launch slips' }] } } }));
  const [x] = hub.snapshot();
  assert.equal(x.name, 'app', 'the name is replaced by the project');
  assert.equal(x.now.summary, undefined);
  assert.equal(hub.allEvents(200)['pc-1:s1'][0].summary, undefined);
  assert.equal(hub.list()[0].outdated, true);
  // A current reporter's summaries written for a tool still come through at activity.
  const hub2 = new Hub();
  hub2.ingest(capped, report({ version: '0.5.1', init: { agents: [a], others: [], events: { s1: [tool] } } }));
  assert.equal(hub2.allEvents(200)['pc-1:s1'][0].summary, 'ls');
  assert.equal(hub2.snapshot()[0].name, 'fix the login bug');
});

test('a restarted hub applies the keys file before serving what it restored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-data-'));
  const a = new Hub({ dataDir: dir });
  a.ingest(entry, report({ init }));
  a.ingest(entry, report({ seq: 2, agents: [] }));
  a.save();
  const b = new Hub({ dataDir: dir, levelFor: () => 'metadata' });
  b.load();
  assert.equal(b.list()[0].share, 'metadata');
  assert.equal(b.archived('pc-1:s1').events['pc-1:s1'][0].detail, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an old reporter first kept at full is still treated as free text when lowered or restored lower', () => {
  const a = agent({ name: 'fix the login bug', now: { verb: 'Calling', label: 'slack · post', summary: 'the launch slips', cat: 'mcp', since: 1 } });
  const body = report({ version: '0.4.1', init: { agents: [a], others: [], events: { s1: [{ ...tool, summary: 'the launch slips' }] } } });
  let cap = 'full';
  const hub = new Hub({ levelFor: () => cap });
  hub.ingest({ name: 'pc-1', share: 'full' }, body, 0);
  assert.equal(hub.snapshot()[0].name, 'fix the login bug', 'at full everything is shared');
  cap = 'activity';
  hub.sweep(1000);
  assert.equal(hub.snapshot()[0].name, 'app');
  assert.equal(hub.snapshot()[0].now.summary, undefined);
  assert.equal(hub.allEvents(200)['pc-1:s1'][0].summary, undefined);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-data-'));
  const h1 = new Hub({ dataDir: dir });
  h1.ingest({ name: 'pc-1', share: 'full' }, body);
  h1.save();
  const h2 = new Hub({ dataDir: dir, levelFor: () => 'activity' });
  h2.load();
  assert.equal(h2.snapshot()[0].name, 'app');
  assert.equal(h2.allEvents(200)['pc-1:s1'][0].summary, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an upgraded reporter does not vouch for what its older version sent', () => {
  const a = agent({ name: 'fix the login bug', now: { verb: 'Calling', label: 'slack · post', summary: 'the launch slips', cat: 'mcp', since: 1 } });
  let cap = 'full';
  const hub = new Hub({ levelFor: () => cap });
  const full = { name: 'pc-1', share: 'full' };
  // 0.4.1 at full: its session ends and is archived…
  hub.ingest(full, report({ version: '0.4.1', init: { agents: [a], others: [], events: { s1: [{ ...tool, summary: 'the launch slips' }] } } }), 0);
  hub.ingest(full, report({ version: '0.4.1', seq: 2, agents: [] }), 1000);
  // …then the machine upgrades (new instance, current version) and later the keys file lowers it.
  hub.ingest(full, report({ version: '0.6.0', instance: 'i2', seq: 1, init: { agents: [], others: [], events: {} } }), 60e3);
  assert.equal(hub.archived('pc-1:s1').marked, false);
  cap = 'activity';
  hub.sweep(61e3);
  const x = hub.archived('pc-1:s1');
  assert.equal(x.agent.name, 'app', "the old version's prompt-made name is dropped");
  assert.equal(x.events['pc-1:s1'][0].summary, undefined);

  // The same survives a restart: the mark is saved with each record.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-data-'));
  const h1 = new Hub({ dataDir: dir });
  h1.ingest(full, report({ version: '0.4.1', init: { agents: [a], others: [], events: { s1: [{ ...tool, summary: 'the launch slips' }] } } }));
  h1.ingest(full, report({ version: '0.4.1', seq: 2, agents: [] }));
  h1.ingest(full, report({ version: '0.6.0', instance: 'i2', seq: 1, init: { agents: [], others: [], events: {} } }), Date.now() + 60e3);
  h1.save();
  const h2 = new Hub({ dataDir: dir, levelFor: () => 'activity' });
  h2.load();
  assert.equal(h2.archived('pc-1:s1').agent.name, 'app');
  assert.equal(h2.archived('pc-1:s1').events['pc-1:s1'][0].summary, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a restarted old reporter's sessions stay unmarked when archived by the next instance", () => {
  const a = agent({ name: 'fix the login bug' });
  let cap = 'full';
  const hub = new Hub({ levelFor: () => cap });
  const full = { name: 'pc-1', share: 'full' };
  hub.ingest(full, report({ version: '0.4.1', init: { agents: [a], others: [], events: { s1: [{ ...tool, summary: 'the launch slips' }] } } }), 0);
  // A new (current) instance's init archives what the old one sent.
  hub.ingest(full, report({ version: '0.6.0', instance: 'i2', seq: 1, init: { agents: [], others: [], events: {} } }), 60e3);
  assert.equal(hub.archived('pc-1:s1').marked, false);
  cap = 'activity';
  hub.sweep(61e3);
  assert.equal(hub.archived('pc-1:s1').agent.name, 'app');
  assert.equal(hub.archived('pc-1:s1').events['pc-1:s1'][0].summary, undefined);
  // What the current instance sends is trusted.
  const hub2 = new Hub();
  hub2.ingest(full, report({ version: '0.6.0', init: { agents: [a], others: [], events: { s1: [tool] } } }), 0);
  hub2.ingest(full, report({ version: '0.6.0', seq: 2, agents: [] }), 1000);
  assert.equal(hub2.archived('pc-1:s1').marked, true);
});
