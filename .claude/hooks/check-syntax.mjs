// PostToolUse hook (Edit|Write): syntax-check a JS file Claude just changed.
// Exit code 2 sends the error back to Claude so it fixes it right away.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const file = input.tool_input?.file_path || input.tool_response?.filePath;
if (!file || !/\.m?js$/.test(file) || !fs.existsSync(file)) process.exit(0);

const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
if (r.status !== 0) {
  process.stderr.write(`node --check failed for ${file}:\n${r.stderr}`);
  process.exit(2);
}
