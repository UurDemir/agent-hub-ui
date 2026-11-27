import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { buildService, removal, serviceArgs, wrapperCommand, ServiceError, TASK, UNIT, LABEL } from '../bin/service.js';

// Arguments that are awkward for every quoting scheme involved.
const tricky = ['a b', 'say "hi"', '100%', '%PATH%', '$HOME', '${X}', 'a&b|c<d>e^f(g)', "it's", 'C:\\dir with space\\', 'back\\"slash', '!bang!', ''];
const report = ['--report-to', 'https://nas:4318', '--report-key-file', '~/.agent-hub-key', '--headless'];

const linux = (over = {}) => buildService({
  platform: 'linux', nodePath: '/opt/node 20/bin/node', scriptPath: '/usr/lib/node_modules/agent-hub-ui/bin/agent-hub.js',
  args: ['--install-service', ...report], home: '/home/me', cwd: '/home/me/work', env: {}, user: 'me', ...over,
});
const mac = (over = {}) => buildService({
  platform: 'darwin', nodePath: '/usr/local/bin/node', scriptPath: '/usr/local/lib/node_modules/agent-hub-ui/bin/agent-hub.js',
  args: ['--install-service', ...report], home: '/Users/me', cwd: '/Users/me', env: {}, uid: 501, user: 'me', ...over,
});
const winEnv = { LOCALAPPDATA: 'C:\\Users\\Jo Ann\\AppData\\Local', SystemRoot: 'C:\\Windows', USERDOMAIN: 'PC', USERNAME: 'Jo Ann' };
const win = (over = {}) => buildService({
  platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'C:\\Users\\Jo Ann\\AppData\\Roaming\\npm\\node_modules\\agent-hub-ui\\bin\\agent-hub.js',
  args: ['--install-service', ...report], home: 'C:\\Users\\Jo Ann', cwd: 'C:\\Users\\Jo Ann\\work', env: winEnv, ...over,
});

/* ---------- readers that undo each format's quoting ---------- */

// systemd's ExecStart= splitting: whitespace-separated, "…" with C escapes, %% and $$.
function systemdWords(line) {
  const words = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ') i++;
    if (i >= line.length) break;
    let w = '';
    if (line[i] === '"') {
      i++;
      while (line[i] !== '"') {
        if (line[i] === '\\') { w += line[i + 1]; i += 2; } else w += line[i++];
      }
      i++;
    } else while (i < line.length && line[i] !== ' ') w += line[i++];
    words.push(w.replace(/%%/g, '%').replace(/\$\$/g, '$'));
  }
  return words;
}

// What cmd.exe does to a batch line before starting the program: %% -> %, ^x -> x outside quotes.
function cmdUnescape(line) {
  let out = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    if (c === '%' && line[i + 1] === '%') { out += '%'; i++; } else if (c === '^' && !quoted) out += line[++i];
    else out += c;
  }
  return out;
}

// CommandLineToArgvW, which Node uses for process.argv on Windows (arguments after the program name).
function argvW(s) {
  const args = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i >= s.length) break;
    let a = '';
    let quoted = false;
    for (; i < s.length && (quoted || (s[i] !== ' ' && s[i] !== '\t')); i++) {
      if (s[i] === '\\') {
        let n = 0;
        while (s[i] === '\\') { n++; i++; }
        if (s[i] === '"') { a += '\\'.repeat(n >> 1); if (n % 2) a += '"'; else { quoted = !quoted; } } else { a += '\\'.repeat(n); i--; }
      } else if (s[i] === '"') {
        if (quoted && s[i + 1] === '"') { a += '"'; i++; } else quoted = !quoted;
      } else a += s[i];
    }
    args.push(a);
  }
  return args;
}

const plistStrings = (xml) => [...xml.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));

/* ---------- options ---------- */

test('service options: service flags and --open dropped, --no-open added, file paths made absolute', () => {
  const ctx = { platform: 'linux', home: '/home/me', cwd: '/home/me/work' };
  assert.deepEqual(
    serviceArgs(['--open', '--install-service', '--report-key-file=key', '--hub-keys', '../keys.json', '--tls-cert', '~/c.pem', '-p', '4400', '--share=activity', '--no-open'], ctx),
    ['--report-key-file', '/home/me/work/key', '--hub-keys', '/home/me/keys.json', '--tls-cert', '/home/me/c.pem', '-p', '4400', '--share', 'activity', '--no-open'],
  );
  assert.deepEqual(serviceArgs(['--report-key-file', '~\\k'], { platform: 'win32', home: 'C:\\Users\\me', cwd: 'D:\\x' }), ['--report-key-file', 'C:\\Users\\me\\k', '--no-open']);
  assert.deepEqual(serviceArgs(['--report-key-file', 'k'], { platform: 'win32', home: 'C:\\Users\\me', cwd: 'D:\\x' }), ['--report-key-file', 'D:\\x\\k', '--no-open']);
});

test('secrets are refused instead of being written into the service', () => {
  const refuses = (fn, re) => assert.throws(fn, (e) => e instanceof ServiceError && re.test(e.message));
  for (const build of [linux, mac, win]) {
    refuses(() => build({ args: ['--install-service', '--viewer-password', 'hunter2'] }), /--viewer-password-file/);
    refuses(() => build({ args: ['--install-service', '--viewer-password=hunter2'] }), /--viewer-password-file/);
    refuses(() => build({ args: ['--install-service'], env: { ...winEnv, AGENT_HUB_VIEWER_PASSWORD: 'hunter2' } }), /--viewer-password-file/);
    refuses(() => build({ args: ['--install-service', '--report-to', 'https://nas:4318'], env: { ...winEnv, AGENT_HUB_REPORT_KEY: 'ahk_secret' } }), /--report-key-file/);
    refuses(() => build({ args: ['--install-service', '--report-to', 'https://nas:4318'] }), /--report-key-file/);
    refuses(() => build({ args: ['--install-service', '--hub'], env: { ...winEnv, AGENT_HUB_MACHINES: '{"machines":[]}' } }), /--hub-keys/);
  }
  // With the file options, the secret variables aren't needed and aren't copied.
  const p = linux({ args: ['--install-service', ...report, '--host', '0.0.0.0', '--viewer-password-file', 'pw'], env: { AGENT_HUB_REPORT_KEY: 'ahk_secret', AGENT_HUB_VIEWER_PASSWORD: 'hunter2' } });
  const text = p.files.map((f) => f.content).join('\n');
  assert.doesNotMatch(text, /ahk_secret|hunter2/);
  assert.match(text, /"--viewer-password-file" "\/home\/me\/work\/pw"/);
});

test('only non-secret environment is carried into the service', () => {
  const p = linux({ env: { CLAUDE_CONFIG_DIR: 'cfg', NODE_EXTRA_CA_CERTS: '/etc/hub-ca.pem', AGENT_HUB_SHARE: 'activity', AWS_SECRET_ACCESS_KEY: 'x', AGENT_HUB_REPORT_KEY: 'ahk_secret' } });
  assert.deepEqual(p.env, { CLAUDE_CONFIG_DIR: '/home/me/work/cfg', NODE_EXTRA_CA_CERTS: '/etc/hub-ca.pem', AGENT_HUB_SHARE: 'activity' });
  assert.match(p.files[0].content, /^Environment="CLAUDE_CONFIG_DIR=\/home\/me\/work\/cfg"$/m);
  assert.doesNotMatch(p.files[0].content, /AWS|ahk_/);
});

test('line breaks in an argument are refused', () => {
  assert.throws(() => linux({ args: ['--install-service', '--allowed-host', 'a\nExecStartPre=/bin/evil'] }), ServiceError);
});

test('npx cache: warns but still builds', () => {
  const p = linux({ scriptPath: '/home/me/.npm/_npx/1234/node_modules/agent-hub-ui/bin/agent-hub.js' });
  assert.match(p.warnings.join('\n'), /npm i -g agent-hub-ui/);
  assert.equal(p.files.length, 1);
  assert.equal(win({ scriptPath: 'C:\\Users\\Jo Ann\\AppData\\Local\\npm-cache\\_npx\\1\\node_modules\\agent-hub-ui\\bin\\agent-hub.js' }).warnings.length, 1);
  assert.equal(linux().warnings.length, 0);
});

/* ---------- Linux ---------- */

test('linux: systemd user unit with the absolute node and script paths', () => {
  const p = linux({ args: ['--install-service', ...report, '--allowed-host', ...tricky.slice(0, 1)] });
  const [f] = p.files;
  assert.equal(f.path, `/home/me/.config/systemd/user/${UNIT}`);
  assert.match(f.content, /^Restart=on-failure$/m);
  assert.match(f.content, /^RestartSec=5$/m);
  assert.match(f.content, /^WantedBy=default.target$/m);
  const exec = /^ExecStart=(.*)$/m.exec(f.content)[1];
  assert.deepEqual(systemdWords(exec), ['/opt/node 20/bin/node', '/usr/lib/node_modules/agent-hub-ui/bin/agent-hub.js',
    '--report-to', 'https://nas:4318', '--report-key-file', '/home/me/.agent-hub-key', '--headless', '--allowed-host', 'a b', '--no-open']);
  assert.doesNotMatch(exec, /--install-service/);
  assert.deepEqual(p.install.filter((s) => s.argv).map((s) => s.argv.join(' ')),
    ['systemctl --user daemon-reload', `systemctl --user enable ${UNIT}`, `systemctl --user restart ${UNIT}`]);
  assert.deepEqual(p.precheck.argv, ['systemctl', '--user', 'show-environment']);
  assert.match(p.notes.join('\n'), /loginctl enable-linger me/);
  assert.match(p.logs, /journalctl --user -u agent-hub/);
  assert.equal(linux({ env: { XDG_CONFIG_HOME: '/cfg' } }).files[0].path, `/cfg/systemd/user/${UNIT}`);
});

test('linux: awkward arguments survive systemd quoting', () => {
  const p = linux({ args: ['--install-service', ...report, ...tricky.flatMap((t) => ['--allowed-host', t])] });
  const words = systemdWords(/^ExecStart=(.*)$/m.exec(p.files[0].content)[1]);
  assert.deepEqual(words.slice(2), p.argv.slice(2));
  assert.deepEqual(words.filter((_, i) => words[i - 1] === '--allowed-host'), tricky);
});

/* ---------- macOS ---------- */

test('macOS: LaunchAgent plist with RunAtLoad, KeepAlive and a log file', () => {
  const p = mac({ args: ['--install-service', ...report, ...tricky.flatMap((t) => ['--allowed-host', t])], env: { CODEX_HOME: '/Users/me/.codex' } });
  const [f] = p.files;
  assert.equal(f.path, `/Users/me/Library/LaunchAgents/${LABEL}.plist`);
  assert.match(f.content, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(f.content, /<key>KeepAlive<\/key><true\/>/);
  assert.match(f.content, /<key>StandardOutPath<\/key><string>\/Users\/me\/Library\/Logs\/agent-hub.log<\/string>/);
  assert.match(f.content, /<key>StandardErrorPath<\/key><string>\/Users\/me\/Library\/Logs\/agent-hub.log<\/string>/);
  assert.match(f.content, /<key>CODEX_HOME<\/key><string>\/Users\/me\/.codex<\/string>/);
  const strings = plistStrings(f.content);
  const args = strings.slice(strings.indexOf('/usr/local/bin/node'), strings.indexOf('--no-open') + 1);
  assert.deepEqual(args, p.argv);
  assert.equal(args[1], '/usr/local/lib/node_modules/agent-hub-ui/bin/agent-hub.js');
  assert.ok(!args.includes('--install-service'));
  assert.deepEqual(args.filter((_, i) => args[i - 1] === '--allowed-host'), tricky);
  const runs = p.install.filter((s) => s.argv);
  assert.deepEqual(runs.at(-1).argv, ['launchctl', 'bootstrap', 'gui/501', f.path]);
  assert.deepEqual(runs.at(-1).fallback, ['launchctl', 'load', '-w', f.path]);
});

/* ---------- Windows ---------- */

test('windows: scheduled task XML at logon for this user, hidden through wscript, run limited', () => {
  const p = win();
  const [wrapper, launcher, xml] = p.files;
  assert.equal(wrapper.path, 'C:\\Users\\Jo Ann\\AppData\\Local\\agent-hub\\agent-hub-service.cmd');
  assert.equal(launcher.path, 'C:\\Users\\Jo Ann\\AppData\\Local\\agent-hub\\agent-hub-launch.js');
  assert.equal(xml.encoding, 'utf16le');
  assert.equal(launcher.encoding, 'utf16le');
  // Window style 0 (hidden), and wait, so the task runs as long as Agent Hub does.
  const run = /\.Run\((".*"), 0, true\);/.exec(launcher.content);
  assert.equal(JSON.parse(run[1]), 'C:\\Windows\\System32\\cmd.exe /d /s /c ""C:\\Users\\Jo Ann\\AppData\\Local\\agent-hub\\agent-hub-service.cmd""');
  assert.match(xml.content, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>PC\\Jo Ann<\/UserId>/);
  assert.match(xml.content, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml.content, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml.content, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml.content, /<Command>C:\\Windows\\System32\\wscript.exe<\/Command>/);
  assert.equal(p.task.arguments, '//B //Nologo //E:JScript "C:\\Users\\Jo Ann\\AppData\\Local\\agent-hub\\agent-hub-launch.js"');
  assert.match(xml.content, /<Arguments>\/\/B \/\/Nologo \/\/E:JScript &quot;C:\\Users\\Jo Ann\\AppData\\Local\\agent-hub\\agent-hub-launch.js&quot;<\/Arguments>/);
  const runs = p.install.filter((s) => s.argv && !s.optional).map((s) => s.argv);
  assert.deepEqual(runs, [
    ['schtasks', '/Create', '/TN', TASK, '/XML', xml.path, '/F'],
    ['schtasks', '/Run', '/TN', TASK],
  ]);
  // The wrapper has CRLF line endings (cmd misreads labels otherwise), logs next to itself and restarts on failure.
  assert.ok(!/[^\r]\n/.test(wrapper.content));
  assert.match(wrapper.content, /^>>"%~dp0agent-hub.log" 2>&1 "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Jo Ann\\AppData\\Roaming\\npm\\node_modules\\agent-hub-ui\\bin\\agent-hub.js" /m);
  assert.match(wrapper.content, /goto run/);
  assert.equal(p.logs, 'C:\\Users\\Jo Ann\\AppData\\Local\\agent-hub\\agent-hub.log');
});

test('windows: a long command stays in the wrapper; the task only points at it', () => {
  const many = Array.from({ length: 40 }, (_, i) => ['--allowed-host', `host-${i}.some-long-domain.example.com`]).flat();
  const p = win({ args: ['--install-service', ...report, ...many] });
  const line = p.files[0].content.split('\r\n').find((l) => l.startsWith('>>'));
  assert.ok(line.length > 1500);
  assert.ok(p.task.arguments.length < 261);
  assert.ok(!p.files.slice(1).some((f) => f.content.includes('host-0')));
});

test('windows: awkward arguments survive cmd.exe and CommandLineToArgvW', () => {
  const p = win({ args: ['--install-service', ...report, ...tricky.flatMap((t) => ['--allowed-host', t])], env: { ...winEnv, CLAUDE_CONFIG_DIR: 'D:\\claude 100%' } });
  const line = p.files[0].content.split('\r\n').find((l) => l.startsWith('>>'));
  const command = cmdUnescape(line.replace(/^>>"%~dp0agent-hub.log" 2>&1 /, ''));
  const args = argvW(command.slice(command.indexOf('.exe" ') + 6));
  assert.deepEqual(args, p.argv.slice(1));
  assert.ok(!args.includes('--install-service'));
  assert.equal(args.at(-1), '--no-open');
  assert.match(p.files[0].content, /^set "CLAUDE_CONFIG_DIR=D:\\claude 100%%"\r$/m);
});

test('windows: uninstall ends and deletes the task and removes the wrapper files', () => {
  const { steps } = removal({ platform: 'win32', home: 'C:\\Users\\Jo Ann', env: winEnv });
  assert.ok(steps.some((s) => s.argv?.join(' ') === `schtasks /Delete /TN ${TASK} /F`));
  assert.deepEqual(steps.filter((s) => s.remove).map((s) => path.win32.basename(s.remove)), ['agent-hub-service.cmd', 'agent-hub-launch.js', 'agent-hub-task.xml']);
  assert.ok(removal({ platform: 'linux', home: '/home/me', env: {} }).steps.some((s) => s.argv?.join(' ') === `systemctl --user disable --now ${UNIT}`));
  assert.ok(removal({ platform: 'darwin', home: '/Users/me', env: {}, uid: 501 }).steps.some((s) => s.argv?.join(' ') === `launchctl bootout gui/501/${LABEL}`));
});

// The real thing: cmd.exe runs the wrapper's command line and Node reads the arguments back.
test('windows: cmd.exe hands the arguments to node unchanged', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-svc '));
  try {
    const echo = path.join(dir, 'echo args.js');
    fs.writeFileSync(echo, 'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))');
    const out = path.join(dir, 'out.json');
    const argv = [process.execPath, echo, out, ...tricky];
    const bat = path.join(dir, 'run.cmd');
    fs.writeFileSync(bat, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${wrapperCommand(argv)}\r\n`);
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${bat}""`], { windowsVerbatimArguments: true, encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}${fs.existsSync(path.join(dir, 'agent-hub.log')) ? fs.readFileSync(path.join(dir, 'agent-hub.log'), 'utf8') : ''}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), tricky);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the server reads the viewer password from AGENT_HUB_VIEWER_PASSWORD_FILE', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-pw-'));
  const pw = path.join(dir, 'pw');
  fs.writeFileSync(pw, 'hunter2\n');
  fs.writeFileSync(path.join(dir, 'empty'), '');
  const env = { ...process.env, PORT: '0', CLAUDE_CONFIG_DIR: dir, CODEX_HOME: path.join(dir, 'x'), OPENCLAW_STATE_DIR: path.join(dir, 'y') };
  delete env.AGENT_HUB_VIEWER_PASSWORD;
  const child = spawn(process.execPath, [path.resolve('server/index.js')], { env: { ...env, AGENT_HUB_VIEWER_PASSWORD_FILE: pw }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let log = '';
    child.stderr.on('data', (d) => { log += d; });
    const url = await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => { log += d; const m = /running at (http:\/\/\S+)/.exec(log); if (m) resolve(m[1]); });
      child.on('exit', () => reject(new Error(log)));
    });
    assert.equal((await fetch(`${url}/api/agents`)).status, 401);
    const auth = { Authorization: `Basic ${Buffer.from('x:hunter2').toString('base64')}` };
    assert.equal((await fetch(`${url}/api/agents`, { headers: auth })).status, 200);
  } finally { child.kill(); }
  const empty = spawnSync(process.execPath, [path.resolve('server/index.js')], { env: { ...env, AGENT_HUB_VIEWER_PASSWORD_FILE: path.join(dir, 'empty') }, encoding: 'utf8', timeout: 20000 });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /is empty/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--print-service prints the plan and installs nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-home-'));
  try {
    const key = path.join(home, 'key');
    fs.writeFileSync(key, 'ahk_x');
    const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'Local'), XDG_CONFIG_HOME: path.join(home, '.config') };
    delete env.AGENT_HUB_REPORT_KEY; delete env.AGENT_HUB_VIEWER_PASSWORD; delete env.AGENT_HUB_MACHINES;
    const r = spawnSync(process.execPath, [path.resolve('bin/agent-hub.js'), '--print-service', '--report-to', 'https://nas:4318', '--report-key-file', key, '--headless'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--install-service runs:/);
    assert.match(r.stdout, /--no-open/);
    assert.doesNotMatch(r.stdout, /--print-service/);
    assert.deepEqual(fs.readdirSync(home), ['key']);
    const refused = spawnSync(process.execPath, [path.resolve('bin/agent-hub.js'), '--print-service', '--viewer-password', 'pw'], { env, encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--viewer-password-file/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
