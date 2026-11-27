import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Notifier, parseTarget, request } from '../server/notify.js';

const agent = (status, extra = {}) => ({
  key: 'k1', sessionId: 'abcdef123456', project: 'shop', name: 'fix the checkout bug', nameFromPrompt: true,
  status, live: true, kind: 'interactive', now: { verb: 'Running', label: 'Bash', summary: 'npm test', cat: 'run', since: 1 },
  lastSay: { text: 'All tests pass now.', t: 1 }, subagents: [], ...extra,
});

function notifier(opts = {}) {
  const sent = [];
  const n = new Notifier({ targets: ['webhook:https://hooks.example/x'], send: (t, init) => { sent.push({ t, init, body: JSON.parse(init.body) }); return { ok: true }; }, ...opts });
  return { n, sent };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('notifies when an agent needs you and when a long turn finishes, not on the first snapshot', async () => {
  const { n, sent } = notifier();
  n.check([agent('working')], null, 0);          // baseline
  n.check([agent('working')], null, 40e3);
  n.check([agent('idle')], null, 60e3);          // worked 60s: finished
  n.check([agent('working')], null, 61e3);
  n.check([agent('waiting')], null, 80e3);       // needs you
  n.check([agent('idle')], null, 85e3);          // only 4s of work after that: no "finished"
  await flush();
  assert.deepEqual(sent.map((s) => s.body.event), ['done', 'waiting']);
  assert.equal(sent[0].body.title, 'shop finished', 'at metadata the project names it, never the prompt');
  assert.equal(sent[1].body.title, 'shop needs you');
  assert.ok(!JSON.stringify(sent).includes('checkout bug'));
  assert.ok(!JSON.stringify(sent).includes('All tests pass'), 'replies only at full');
});

test('the notification level decides what it says', async () => {
  const { n, sent } = notifier({ share: 'full', minSeconds: 0 });
  n.check([agent('working')], null, 0);
  n.check([agent('idle')], null, 1000);
  await flush();
  assert.equal(sent[0].body.title, 'fix the checkout bug finished');
  assert.match(sent[0].body.body, /All tests pass now\./);
});

test('rate limits per agent', async () => {
  const { n, sent } = notifier({ minSeconds: 0 });
  n.check([agent('working')], null, 0);
  n.check([agent('waiting')], null, 1000);
  n.check([agent('working')], null, 2000);
  n.check([agent('waiting')], null, 3000);       // within 10s of the last one for this agent
  n.check([agent('working')], null, 20e3);
  n.check([agent('waiting')], null, 21e3);
  await flush();
  assert.equal(sent.length, 2);
});

test('machine connects and disconnects are opt-in', async () => {
  const { n, sent } = notifier({ on: ['machine'] });
  const ms = (online) => [{ id: '@local', local: true, online: true }, { id: 'laptop', online }];
  n.check([], ms(true), 0);
  n.check([], ms(false), 1000);
  n.check([], ms(true), 20e3);
  await flush();
  assert.deepEqual(sent.map((s) => s.body.title), ['laptop disconnected', 'laptop reconnected']);
  assert.throws(() => new Notifier({ targets: ['webhook:https://x/y'], on: ['bogus'] }), /unknown event/);
});

test('targets: each service gets its own request, and secrets stay out of the label', () => {
  const ntfy = parseTarget('ntfy:https://me:s3cret@ntfy.example/agents');
  assert.equal(ntfy.url.href, 'https://ntfy.example/agents', 'credentials move to a header');
  assert.equal(ntfy.headers.Authorization, `Basic ${Buffer.from('me:s3cret').toString('base64')}`);
  assert.equal(ntfy.label, 'ntfy ntfy.example');
  const n = { event: 'waiting', title: 'shop needs you', body: 'Claude Code · shop', agent: {}, t: 1 };
  const r = request(ntfy, n);
  assert.equal(r.headers.Title, 'shop needs you');
  assert.equal(r.headers.Priority, '4');
  assert.equal(r.body, 'Claude Code · shop');

  const tg = parseTarget('telegram:123456:ABC-def_ghi/-1001234');
  assert.equal(tg.label, 'telegram');
  assert.equal(JSON.parse(request(tg, n).body).chat_id, '-1001234');
  assert.match(tg.url.href, /^https:\/\/api\.telegram\.org\/bot123456:ABC-def_ghi\/sendMessage$/);

  const gotify = parseTarget('gotify:https://push.example/message?token=APP');
  assert.equal(gotify.label, 'gotify push.example');
  assert.equal(JSON.parse(request(gotify, n).body).priority, 7);
  assert.deepEqual(JSON.parse(request(parseTarget('discord:https://discord.com/api/webhooks/1/x'), n).body).allowed_mentions, { parse: [] });
  assert.throws(() => parseTarget('https://ntfy.sh/x'), /start the target with one of/);
  assert.throws(() => parseTarget('ntfy:ftp://x/y'), /http\(s\)/);
});
