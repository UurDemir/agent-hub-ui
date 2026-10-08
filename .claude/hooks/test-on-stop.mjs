// Stop hook: when JS files have uncommitted changes, run the test suite before Claude finishes.
// Exit code 2 keeps Claude working with the failures; stop_hook_active prevents a retry loop.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
if (input.stop_hook_active) process.exit(0);

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const status = spawnSync('git', ['status', '--porcelain', '-uall', '--', '*.js', '*.mjs'], { cwd, encoding: 'utf8' });
if (status.status !== 0 || !status.stdout.trim()) process.exit(0);

const r = spawnSync(process.execPath, ['--test'], { cwd, encoding: 'utf8', timeout: 120000 });
if (r.status !== 0) {
  const out = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-60).join('\n');
  process.stderr.write(`Tests fail after your changes (npm test):\n${out}`);
  process.exit(2);
}
