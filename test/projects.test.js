import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, parseFrontmatter, slug } from '../server/projects.js';

test('slug matches the ~/.claude/projects folder naming', () => {
  assert.equal(slug('E:\\Projects\\My Projects\\agent-hub-ui'), 'E--Projects-My-Projects-agent-hub-ui');
  assert.equal(slug('/home/me/app.v2'), '-home-me-app-v2');
});

test('redact hides tokens, credentials and secret values', () => {
  const cases = [
    ['npx server --key sk-ant-abcdefghijklmnop', 'npx server --key •••'],
    ['GITHUB=ghp_abcdefghijklmnopqrst', 'GITHUB=•••'],
    ['Authorization: Bearer abc.def.ghi', 'Authorization: Bearer •••'],
    ['postgres://admin:hunter2@db:5432/x', 'postgres://•••@db:5432/x'],
    ['docker run -e API_TOKEN=s3cret img', 'docker run -e API_TOKEN=••• img'],
    ['--password=hunter2 --verbose', '--password=••• --verbose'],
    ['{"api_key": "abc123"}', '{"api_key": "•••"}'],
    ['npx server --api-key abc123 --verbose', 'npx server --api-key ••• --verbose'],
    ['tool --token xyz', 'tool --token •••'],
    ['key=AIzaSyA1234567890abcdefghijklmnopqrstuv', 'key=•••'],
    ['STRIPE sk_live_abcdefghijklmn', 'STRIPE •••'],
    ['glpat-abcdefghijklmnopqrst', '•••'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test('redact leaves ordinary commands alone', () => {
  assert.equal(redact('node server.js --port 3000'), 'node server.js --port 3000');
  assert.equal(redact('cli --token-file ./t --token --verbose'), 'cli --token-file ./t --token --verbose');
  assert.equal(redact(undefined), '');
});

test('parseFrontmatter reads scalars, lists, maps and block strings', () => {
  const { meta, body } = parseFrontmatter([
    '---',
    'name: reviewer',
    'description: "Reviews code"',
    'tools: [Read, Grep]',
    'paths:',
    '  - src/**',
    '  - test/**',
    'metadata:',
    '  type: feedback',
    'summary: >',
    '  first line',
    '  second line',
    '---',
    'Body text',
  ].join('\n'));
  assert.equal(meta.name, 'reviewer');
  assert.equal(meta.description, 'Reviews code');
  assert.equal(meta.tools, '[Read, Grep]');
  assert.deepEqual(meta.paths, ['src/**', 'test/**']);
  assert.deepEqual(meta.metadata, { type: 'feedback' });
  assert.equal(meta.summary, 'first line second line');
  assert.equal(body, 'Body text');
});

test('parseFrontmatter handles CRLF and files without frontmatter', () => {
  assert.equal(parseFrontmatter('---\r\nname: x\r\n---\r\nhi').meta.name, 'x');
  assert.deepEqual(parseFrontmatter('just text'), { meta: {}, body: 'just text' });
});
