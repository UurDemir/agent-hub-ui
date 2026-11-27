// `agent-hub --install-service <options>`: runs Agent Hub as a per-user background service.
// The definitions (scheduled task + .cmd wrapper on Windows, LaunchAgent on macOS, systemd user unit
// on Linux) are built by pure functions from { platform, nodePath, scriptPath, args, home, cwd, env },
// so tests check them without installing anything. runService() at the bottom is the only part that
// writes files or runs schtasks / systemctl / launchctl, always with argument arrays, never a shell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TASK = 'Agent Hub'; // Windows scheduled task
export const UNIT = 'agent-hub.service'; // systemd user unit
export const LABEL = 'ui.agent-hub'; // macOS LaunchAgent
export const ACTIONS = ['--install-service', '--uninstall-service', '--service-status', '--print-service'];

const VALUE_FLAGS = new Set(['-p', '--port', '--host', '--report-to', '--report-key-file', '--share', '--hub-keys',
  '--ingest-port', '--ingest-host', '--tls-cert', '--tls-key', '--allowed-host', '--viewer-password',
  '--viewer-password-file', '--new-key', '--notify', '--notify-file', '--notify-share', '--notify-on',
  '--notify-min-seconds', '--data-dir', '--retain-days']);
// Relative paths are resolved now: the service doesn't start in the folder you installed it from.
const FILE_FLAGS = new Set(['--report-key-file', '--viewer-password-file', '--hub-keys', '--tls-cert', '--tls-key', '--notify-file', '--data-dir']);
const DROP = new Set([...ACTIONS, '--open', '--no-open']);
// Environment the service keeps from the shell that installs it: where the agents keep their state,
// a CA for a self-signed hub, and Agent Hub settings given as env vars instead of flags. Nothing secret:
// the key and password variables are refused below.
const PATH_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME', 'GEMINI_CLI_HOME', 'COPILOT_HOME',
  'XDG_DATA_HOME', 'OPENCODE_DB', 'NODE_EXTRA_CA_CERTS',
  'AGENT_HUB_REPORT_KEY_FILE', 'AGENT_HUB_VIEWER_PASSWORD_FILE', 'AGENT_HUB_KEYS', 'AGENT_HUB_TLS_CERT', 'AGENT_HUB_TLS_KEY',
  'AGENT_HUB_NOTIFY_FILE', 'AGENT_HUB_DATA_DIR'];
const PLAIN_ENV = ['PORT', 'HOST', 'OPENCLAW_PROFILE', 'AGENT_HUB_REPORT_TO', 'AGENT_HUB_SHARE', 'AGENT_HUB_ALLOW_HTTP',
  'AGENT_HUB_HEADLESS', 'AGENT_HUB_HUB', 'AGENT_HUB_INGEST_PORT', 'AGENT_HUB_INGEST_HOST', 'AGENT_HUB_ALLOWED_HOSTS',
  'AGENT_HUB_ALLOW_SEND', 'AGENT_HUB_NOTIFY_SHARE', 'AGENT_HUB_NOTIFY_ON', 'AGENT_HUB_NOTIFY_MIN_SECONDS',
  'AGENT_HUB_METRICS', 'AGENT_HUB_RETAIN_DAYS'];

export class ServiceError extends Error {}
const fail = (msg) => { throw new ServiceError(msg); };
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

function resolvePath(p, { platform, home, cwd }) {
  const P = pathFor(platform);
  if (p === '~') return home;
  if (p.startsWith('~/') || (platform === 'win32' && p.startsWith('~\\'))) return P.join(home, p.slice(2));
  return P.resolve(cwd, p);
}

/** The command line options the service runs with: the service flags and --open dropped, --no-open added. */
export function serviceArgs(args, ctx) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith('-') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (DROP.has(flag)) continue;
    if (!VALUE_FLAGS.has(flag)) { out.push(a); continue; }
    let v = eq > 0 ? a.slice(eq + 1) : args[++i];
    if (v === undefined) fail(`Missing value for ${flag}`);
    if (FILE_FLAGS.has(flag)) v = resolvePath(v, ctx);
    out.push(flag, v);
  }
  out.push('--no-open');
  return out;
}

// A service definition is a plain file other programs (and backups) can read, so no secret goes in it.
function check(args, env) {
  const has = (flag, name) => args.includes(flag) || !!env[name];
  if (args.includes('--viewer-password')) {
    fail('--viewer-password would be saved in plain text in the service definition. Put the password in a file only you can read and pass --viewer-password-file <file> instead.');
  }
  if (env.AGENT_HUB_VIEWER_PASSWORD && !has('--viewer-password-file', 'AGENT_HUB_VIEWER_PASSWORD_FILE')) {
    fail('$AGENT_HUB_VIEWER_PASSWORD is set, but the service would have to store it in plain text. Put the password in a file only you can read and pass --viewer-password-file <file> instead.');
  }
  if (has('--report-to', 'AGENT_HUB_REPORT_TO') && !has('--report-key-file', 'AGENT_HUB_REPORT_KEY_FILE')) {
    fail(env.AGENT_HUB_REPORT_KEY
      ? '$AGENT_HUB_REPORT_KEY is set, but the service would have to store it in plain text. Save the key to a file only you can read and pass --report-key-file <file> instead.'
      : 'A reporting service needs the machine key in a file: pass --report-key-file <file>.');
  }
  // Notification targets carry tokens (webhook URLs, bot tokens, ntfy credentials).
  if (args.includes('--notify') || args.some((a) => a.startsWith('--notify='))) {
    fail('--notify targets usually contain a token, which would be saved in plain text in the service definition. Put them in a file only you can read, one per line, and pass --notify-file <file> instead.');
  }
  if (env.AGENT_HUB_NOTIFY) {
    fail('$AGENT_HUB_NOTIFY isn\'t copied into the service, since its targets usually contain a token. Put them in a file, one per line, and pass --notify-file <file>.');
  }
  if (env.AGENT_HUB_MACHINES && !has('--hub-keys', 'AGENT_HUB_KEYS')) {
    fail('$AGENT_HUB_MACHINES isn\'t copied into the service. Save its JSON to a file and pass --hub-keys <file> (the hub re-reads it when it changes).');
  }
  if (has('--headless', 'AGENT_HUB_HEADLESS') && !has('--report-to', 'AGENT_HUB_REPORT_TO')) fail('--headless only makes sense with --report-to <hub url>.');
  if (has('--hub', 'AGENT_HUB_HUB') && !has('--hub-keys', 'AGENT_HUB_KEYS')) fail('--hub needs --hub-keys <file>: the machines allowed to report.');
}

function serviceEnv(env, ctx) {
  const out = {};
  for (const k of PATH_ENV) if (env[k]) out[k] = resolvePath(env[k], ctx);
  for (const k of PLAIN_ENV) if (env[k]) out[k] = env[k];
  return out;
}

/** Where each OS's definition lives. */
export function locations({ platform, home, env = {} }) {
  if (platform === 'win32') {
    const P = path.win32;
    const dir = P.join(env.LOCALAPPDATA || P.join(home, 'AppData', 'Local'), 'agent-hub');
    return {
      dir,
      wrapper: P.join(dir, 'agent-hub-service.cmd'),
      launcher: P.join(dir, 'agent-hub-launch.js'),
      xml: P.join(dir, 'agent-hub-task.xml'),
      log: P.join(dir, 'agent-hub.log'),
    };
  }
  const P = path.posix;
  if (platform === 'darwin') {
    return { file: P.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`), log: P.join(home, 'Library', 'Logs', 'agent-hub.log') };
  }
  const config = env.XDG_CONFIG_HOME && P.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : P.join(home, '.config');
  return { file: P.join(config, 'systemd', 'user', UNIT) };
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/* ---------- Windows ---------- */

// One argument as CommandLineToArgvW (which Node uses for process.argv) reads it back.
export function winQuote(s) {
  if (s && !/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// Makes a command line survive cmd.exe inside a .cmd file: `%` is doubled everywhere, and cmd's
// metacharacters are escaped with ^ wherever cmd thinks it is outside quotes (it toggles on every
// `"`, escaped or not, so this follows the same rule).
export function cmdEscape(line) {
  let quoted = false;
  let out = '';
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    if (c === '%') out += '%%';
    else if (!quoted && '^&|<>()'.includes(c)) out += `^${c}`;
    else out += c;
  }
  return out;
}

/** The line of the .cmd wrapper that starts Agent Hub. Redirection goes first, so an odd number of
 *  quotes in an argument can't swallow it. */
export const wrapperCommand = (argv) => `>>"%~dp0agent-hub.log" 2>&1 ${cmdEscape(argv.map(winQuote).join(' '))}`;

// How the task stays invisible: it runs wscript.exe on a one-line JScript launcher, which starts
// cmd.exe on the wrapper with its window hidden (WScript.Shell.Run style 0) and waits, so the task
// shows as running for as long as Agent Hub does. wscript is a GUI program, so nothing flashes.
// The alternatives were worse: node.exe or cmd.exe started directly opens a console window;
// powershell -WindowStyle Hidden flashes one at every logon (and Windows Terminal, when it is the
// default terminal, may not hide it at all); conhost.exe --headless exits without starting anything
// when it has no console input to read, which is the case under Task Scheduler; and a .vbs launcher
// needs VBScript, which Windows is phasing out. JScript is not part of that deprecation, and the
// launcher passes //E:JScript so the .js file association doesn't matter.
//
// The task is created from XML rather than `schtasks /SC ONLOGON /TR …` because schtasks' defaults
// would stop Agent Hub after 3 days and never start it on a laptop running on battery; /TR is also
// limited to 261 characters. The wrapper holds the actual command (any length), the environment,
// the log redirection, and a restart 5 s after a failure (systemd's Restart=on-failure).
function windows(opts, argv, svcEnv, loc) {
  const sys = path.win32.join(opts.env.SystemRoot || opts.env.windir || 'C:\\Windows', 'System32');
  const wscript = path.win32.join(sys, 'wscript.exe');
  const cmd = path.win32.join(sys, 'cmd.exe');
  for (const v of Object.values(svcEnv)) if (v.includes('"')) fail(`Can't put a double quote in an environment variable for the service: ${v}`);
  const wrapper = [
    '@echo off',
    'rem Agent Hub background service, written by agent-hub --install-service.',
    'rem The scheduled task "Agent Hub" runs it at logon. Remove both with agent-hub --uninstall-service.',
    'chcp 65001 >nul',
    'setlocal DisableDelayedExpansion',
    ...Object.entries(svcEnv).map(([k, v]) => `set "${k}=${v.replace(/%/g, '%%')}"`),
    'cd /d "%USERPROFILE%"',
    ':run',
    'if exist "%~dp0agent-hub.log" for %%F in ("%~dp0agent-hub.log") do if %%~zF GTR 5000000 move /y "%%~fF" "%~dp0agent-hub.old.log" >nul',
    wrapperCommand(argv),
    'if errorlevel 1 (',
    '  ping -n 6 127.0.0.1 >nul',
    '  goto run',
    ')',
    '',
  ].join('\r\n');
  const user = opts.env.USERDOMAIN && opts.env.USERNAME ? `${opts.env.USERDOMAIN}\\${opts.env.USERNAME}` : opts.user;
  if (!user) fail('Can\'t tell which Windows user the task is for (USERNAME isn\'t set).');
  // cmd /s /c ""…"" strips the outer quotes only, so a wrapper path with spaces stays one word.
  const launcher = `// Agent Hub: runs agent-hub-service.cmd without a window. Written by agent-hub --install-service.\r
new ActiveXObject("WScript.Shell").Run(${JSON.stringify(`${winQuote(cmd)} /d /s /c ""${loc.wrapper}""`)}, 0, true);\r
`;
  const action = `//B //Nologo //E:JScript ${winQuote(loc.launcher)}`;
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Agent Hub in the background. Installed by agent-hub --install-service; remove it with agent-hub --uninstall-service.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEsc(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEsc(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEsc(wscript)}</Command>
      <Arguments>${xmlEsc(action)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
  const stop = [
    { argv: ['schtasks', '/End', '/TN', TASK], optional: true, quiet: true },
    { argv: winKill(loc.wrapper), show: `powershell: stop the node.exe started by ${loc.wrapper}`, optional: true, quiet: true },
  ];
  return {
    what: `a scheduled task "${TASK}" that starts at logon (hidden, as ${user})`,
    files: [
      { path: loc.wrapper, content: wrapper },
      // UTF-16 with a BOM: how wscript and schtasks read text that isn't in the ANSI code page.
      { path: loc.launcher, content: launcher, encoding: 'utf16le' },
      { path: loc.xml, content: xml, encoding: 'utf16le' },
    ],
    task: { command: wscript, arguments: action },
    install: [
      ...stop,
      { write: loc.wrapper }, { write: loc.launcher }, { write: loc.xml },
      { argv: ['schtasks', '/Create', '/TN', TASK, '/XML', loc.xml, '/F'] },
      { argv: ['schtasks', '/Run', '/TN', TASK] },
    ],
    logs: loc.log,
    notes: [],
  };
}

const psString = (s) => `'${s.replace(/'/g, "''")}'`;
// PowerShell that lists the cmd.exe running the wrapper; `then` gets $s for each.
const psWrapperShells = (wrapper, then) => `$w = ${psString(wrapper.toLowerCase())}
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($w) } | ForEach-Object { $s = $_; ${then} }`;
const encoded = (script) => ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
// Ending the task may leave the wrapper's node.exe running, so stop the wrapper first (it would restart
// node), then what it started.
export const winKill = (wrapper) => encoded(psWrapperShells(wrapper,
  '$kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($s.ProcessId)"); Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue; $kids | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'));
export const winPids = (wrapper) => encoded(psWrapperShells(wrapper,
  'Get-CimInstance Win32_Process -Filter "ParentProcessId=$($s.ProcessId) AND Name=\'node.exe\'" | ForEach-Object { $_.ProcessId }'));

/* ---------- Linux (systemd) ---------- */

// systemd unit quoting: C-style escapes inside double quotes, %% for a literal % (specifiers), and
// $$ for a literal $ in ExecStart (environment variable substitution).
const sdQuote = (s, { dollar = true } = {}) => {
  let v = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (dollar) v = v.replace(/\$/g, '$$$$');
  return `"${v}"`;
};

function linux(opts, argv, svcEnv, loc) {
  const unit = `# Written by agent-hub --install-service. Remove it with agent-hub --uninstall-service.
[Unit]
Description=Agent Hub
Documentation=https://github.com/UurDemir/agent-hub-ui

[Service]
Type=simple
WorkingDirectory=%h
${Object.entries(svcEnv).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`, { dollar: false })}\n`).join('')}ExecStart=${argv.map((a) => sdQuote(a)).join(' ')}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  const sc = (...a) => ['systemctl', '--user', ...a];
  return {
    what: `a systemd user service (${UNIT})`,
    files: [{ path: loc.file, content: unit }],
    precheck: { argv: sc('show-environment') },
    // restart rather than enable --now, so installing again picks up new options.
    install: [{ write: loc.file }, { argv: sc('daemon-reload') }, { argv: sc('enable', UNIT) }, { argv: sc('restart', UNIT) }],
    logs: 'journalctl --user -u agent-hub -f',
    notes: [`It starts when you log in. To keep it running while you're logged out, and start it at boot: loginctl enable-linger ${opts.user || '$USER'}`],
  };
}

/* ---------- macOS (launchd) ---------- */

function mac(opts, argv, svcEnv, loc) {
  const str = (s) => `<string>${xmlEsc(s)}</string>`;
  const envBlock = Object.keys(svcEnv).length
    ? `  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(svcEnv).map(([k, v]) => `    <key>${xmlEsc(k)}</key>${str(v)}\n`).join('')}  </dict>
`
    : '';
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by agent-hub --install-service. Remove it with agent-hub --uninstall-service. -->
<plist version="1.0">
<dict>
  <key>Label</key>${str(LABEL)}
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    ${str(a)}\n`).join('')}  </array>
${envBlock}  <key>WorkingDirectory</key>${str(opts.home)}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key>${str(loc.log)}
  <key>StandardErrorPath</key>${str(loc.log)}
</dict>
</plist>
`;
  const target = `gui/${opts.uid ?? '$(id -u)'}`;
  return {
    what: `a LaunchAgent (${LABEL})`,
    files: [{ path: loc.file, content: plist }],
    install: [
      { argv: ['launchctl', 'bootout', `${target}/${LABEL}`], optional: true, quiet: true },
      { mkdir: path.posix.dirname(loc.log) },
      { write: loc.file },
      // Right after a bootout, bootstrap can fail until launchd has let go of the old job: retry once.
      { argv: ['launchctl', 'bootstrap', target, loc.file], retry: true, fallback: ['launchctl', 'load', '-w', loc.file] },
    ],
    logs: loc.log,
    notes: [],
  };
}

/* ---------- plans ---------- */

const supported = (platform) => {
  if (!['win32', 'darwin', 'linux'].includes(platform)) fail(`Installing a service is supported on Windows, macOS and Linux (systemd), not ${platform}.`);
};

/** What --install-service writes and runs. Throws ServiceError when it would have to store a secret. */
export function buildService(opts) {
  const { platform } = opts;
  supported(platform);
  const env = opts.env || {};
  const ctx = { platform, home: opts.home, cwd: opts.cwd || opts.home };
  const args = serviceArgs(opts.args, ctx);
  check(args, env);
  const svcEnv = serviceEnv(env, ctx);
  const argv = [opts.nodePath, opts.scriptPath, ...args];
  for (const v of [...argv, ...Object.values(svcEnv)]) {
    if (/[\0-\x1f\x7f]/.test(v)) fail(`Can't put a line break or control character in a service argument: ${JSON.stringify(v)}`);
  }
  const loc = locations({ platform, home: opts.home, env });
  const def = (platform === 'win32' ? windows : platform === 'darwin' ? mac : linux)({ ...opts, env }, argv, svcEnv, loc);
  const warnings = [];
  if (/[\\/]_npx[\\/]/.test(opts.scriptPath)) {
    warnings.push(`This Agent Hub runs from npx's cache (${opts.scriptPath}), which npm may clean up; the service would then stop starting. Install it first with "npm i -g agent-hub-ui", then run "agent-hub --install-service …".`);
  }
  const exists = opts.exists || (() => true);
  for (let i = 0; i < args.length - 1; i++) {
    if (FILE_FLAGS.has(args[i]) && !exists(args[i + 1])) warnings.push(`${args[i]} ${args[i + 1]} doesn't exist; the service won't start until it does.`);
  }
  const notes = [...def.notes];
  if (args.includes('--allow-send') || env.AGENT_HUB_ALLOW_SEND === '1') notes.push('With --allow-send, the one-use link that unlocks sending is printed to the log.');
  return { platform, argv, env: svcEnv, warnings, ...def, notes, uninstall: removal({ ...opts, env }).steps };
}

/** What --uninstall-service runs. Needs no options. */
export function removal(opts) {
  supported(opts.platform);
  const loc = locations({ platform: opts.platform, home: opts.home, env: opts.env });
  if (opts.platform === 'win32') {
    return {
      loc,
      steps: [
        { argv: ['schtasks', '/End', '/TN', TASK], optional: true, quiet: true },
        { argv: winKill(loc.wrapper), show: `powershell: stop the node.exe started by ${loc.wrapper}`, optional: true, quiet: true },
        { argv: ['schtasks', '/Delete', '/TN', TASK, '/F'], optional: true },
        { remove: loc.wrapper }, { remove: loc.launcher }, { remove: loc.xml },
      ],
    };
  }
  if (opts.platform === 'darwin') {
    const target = `gui/${opts.uid ?? '$(id -u)'}`;
    return {
      loc,
      steps: [
        { argv: ['launchctl', 'bootout', `${target}/${LABEL}`], fallback: ['launchctl', 'unload', '-w', loc.file], optional: true },
        { remove: loc.file },
      ],
    };
  }
  const sc = (...a) => ['systemctl', '--user', ...a];
  return {
    loc,
    steps: [
      { argv: sc('disable', '--now', UNIT), optional: true },
      { remove: loc.file },
      { argv: sc('daemon-reload'), optional: true },
      { argv: sc('reset-failed', UNIT), optional: true, quiet: true },
    ],
  };
}

/* ---------- side effects ---------- */

// For showing commands to people (they are run with argument arrays, not through a shell).
const shQuote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const show = (step) => step.show || step.argv.map((a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : /["$`]/.test(a) ? shQuote(a) : `"${a}"`)).join(' ');
const runArgv = (argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000 });
const ok = (r) => !r.error && r.status === 0;
const output = (r) => (r.error ? r.error.message : `${r.stdout || ''}${r.stderr || ''}`.trim());

function execute(plan, steps) {
  for (const s of steps) {
    if (s.mkdir) { fs.mkdirSync(s.mkdir, { recursive: true }); continue; }
    if (s.write) {
      const f = plan.files.find((x) => x.path === s.write);
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(f.path, f.encoding === 'utf16le' ? Buffer.from(`\ufeff${f.content}`, 'utf16le') : f.content);
      console.log(`Wrote ${f.path}`);
      continue;
    }
    if (s.remove) {
      if (fs.existsSync(s.remove)) { fs.rmSync(s.remove, { force: true }); console.log(`Removed ${s.remove}`); }
      continue;
    }
    let r = runArgv(s.argv);
    if (!ok(r) && s.retry) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); r = runArgv(s.argv); }
    if (!ok(r) && s.fallback) r = runArgv(s.fallback);
    if (!ok(r)) {
      if (s.optional) continue;
      fail(`This failed: ${show(s)}\n${output(r)}`);
    }
    if (!s.quiet) console.log(`Ran ${show(s)}`);
  }
}

const indent = (text) => text.replace(/\r/g, '').trimEnd().split('\n').map((l) => `    ${l}`).join('\n');

function describe(plan) {
  const lines = [];
  for (const w of plan.warnings) lines.push(`Warning: ${w}`, '');
  lines.push(`Agent Hub as ${plan.what}, running:`, indent(plan.platform === 'win32' ? plan.argv.map(winQuote).join(' ') : plan.argv.map(shQuote).join(' ')));
  if (Object.keys(plan.env).length) lines.push('with:', indent(Object.entries(plan.env).map(([k, v]) => `${k}=${v}`).join('\n')));
  return lines;
}

function printPlan(plan) {
  const lines = describe(plan);
  for (const f of plan.files) lines.push('', `${f.path}${f.encoding === 'utf16le' ? ' (UTF-16)' : ''}:`, indent(f.content));
  if (plan.precheck) lines.push('', `Checks first that this works (otherwise prints the file and the commands to run by hand):`, `    ${show(plan.precheck)}`);
  lines.push('', '--install-service runs:');
  for (const s of plan.install) {
    if (s.write) lines.push(`    (write ${s.write})`);
    else if (s.mkdir) lines.push(`    (create folder ${s.mkdir})`);
    else lines.push(`    ${show(s)}${s.fallback ? `   (if that fails: ${show({ argv: s.fallback })})` : ''}${s.optional ? '   (errors ignored)' : ''}`);
  }
  lines.push('', '--uninstall-service runs:');
  for (const s of plan.uninstall) lines.push(s.remove ? `    (delete ${s.remove})` : `    ${show(s)}${s.fallback ? `   (if that fails: ${show({ argv: s.fallback })})` : ''}${s.optional ? '   (errors ignored)' : ''}`);
  lines.push('', `Logs: ${plan.logs}`);
  for (const n of plan.notes) lines.push(n);
  console.log(lines.join('\n'));
  return 0;
}

function install(plan) {
  if (plan.precheck && !ok(runArgv(plan.precheck.argv))) {
    const f = plan.files[0];
    console.error(`"${show(plan.precheck)}" doesn't work here, so there's no systemd user session to install into (common in containers and WSL without systemd).
To set it up by hand, save this as ${f.path}:

${indent(f.content)}

and run:
    systemctl --user daemon-reload
    systemctl --user enable --now ${UNIT}

Otherwise run agent-hub with the same options from your own startup script or supervisor.`);
    return 1;
  }
  for (const w of plan.warnings) console.warn(`Warning: ${w}`);
  execute(plan, plan.install);
  console.log(`
${describe({ ...plan, warnings: [] }).join('\n')}
It is installed and started.
Logs:    ${plan.logs}
Status:  agent-hub --service-status
Remove:  agent-hub --uninstall-service${plan.notes.map((n) => `\n${n}`).join('')}
If you move or upgrade Node.js or Agent Hub, run --install-service again.`);
  return 0;
}

function uninstall(opts) {
  const { loc, steps } = removal(opts);
  const installed = opts.platform === 'win32'
    ? ok(runArgv(['schtasks', '/Query', '/TN', TASK])) || fs.existsSync(loc.wrapper)
    : fs.existsSync(loc.file);
  if (!installed) { console.log('No Agent Hub service is installed.'); return 0; }
  execute({ files: [] }, steps);
  console.log('Agent Hub service removed.');
  if (loc.log && fs.existsSync(loc.log)) console.log(`The log is still at ${loc.log}`);
  return 0;
}

function tail(file, n = 10) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, 8192));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      return buf.toString('utf8').replace(/\r/g, '').trimEnd().split('\n').slice(-n).join('\n');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function status(opts) {
  const { loc } = removal(opts);
  let running = false;
  if (opts.platform === 'win32') {
    const q = runArgv(['schtasks', '/Query', '/TN', TASK, '/FO', 'LIST']);
    if (!ok(q)) { console.log(`Not installed (no scheduled task "${TASK}").`); return 1; }
    console.log(`Installed: scheduled task "${TASK}", wrapper ${loc.wrapper}`);
    console.log(indent(q.stdout));
    const pids = runArgv(winPids(loc.wrapper)).stdout?.trim().split(/\s+/).filter(Boolean) || [];
    running = pids.length > 0;
    console.log(running ? `Running (node.exe pid ${pids.join(', ')})` : 'Not running');
  } else if (opts.platform === 'darwin') {
    if (!fs.existsSync(loc.file)) { console.log(`Not installed (no ${loc.file}).`); return 1; }
    console.log(`Installed: ${loc.file}`);
    const p = runArgv(['launchctl', 'print', `gui/${opts.uid}/${LABEL}`]);
    if (ok(p)) {
      const state = /^\s*state = (.+)$/m.exec(p.stdout)?.[1];
      const pid = /^\s*pid = (\d+)$/m.exec(p.stdout)?.[1];
      running = state === 'running';
      console.log(`State: ${state || 'unknown'}${pid ? ` (pid ${pid})` : ''}`);
    } else {
      const l = runArgv(['launchctl', 'list', LABEL]);
      const pid = /"PID" = (\d+);/.exec(l.stdout || '')?.[1];
      running = !!pid;
      console.log(ok(l) ? (pid ? `Running (pid ${pid})` : 'Loaded, not running') : 'Not loaded');
    }
  } else {
    if (!fs.existsSync(loc.file)) { console.log(`Not installed (no ${loc.file}).`); return 1; }
    console.log(`Installed: ${loc.file}`);
    const s = runArgv(['systemctl', '--user', 'status', UNIT, '--no-pager', '--lines=10']);
    if (s.error) console.log(`Can't ask systemctl: ${s.error.message}`);
    else console.log(indent(s.stdout || s.stderr || ''));
    running = runArgv(['systemctl', '--user', 'is-active', UNIT]).stdout?.trim() === 'active';
    console.log(running ? 'Running' : 'Not running');
    console.log('Logs: journalctl --user -u agent-hub -f');
  }
  if (loc.log) {
    const t = tail(loc.log);
    console.log(t ? `Last lines of ${loc.log}:\n${indent(t)}` : `Log: ${loc.log} (empty or not created yet)`);
  }
  return running ? 0 : 3;
}

/** The CLI's entry: action is one of ACTIONS, args the full command line, env the environment as the
 *  user started agent-hub (before the CLI copied flags into it). Returns the exit code. */
export function runService(action, { args, env }) {
  const opts = {
    platform: process.platform,
    nodePath: process.execPath,
    scriptPath: fileURLToPath(new URL('./agent-hub.js', import.meta.url)),
    args,
    home: os.homedir(),
    cwd: process.cwd(),
    env,
    uid: process.getuid?.(),
    user: os.userInfo().username,
    exists: (p) => fs.existsSync(p),
  };
  try {
    if (action === '--print-service') return printPlan(buildService(opts));
    if (action === '--install-service') return install(buildService(opts));
    if (action === '--uninstall-service') return uninstall(opts);
    return status(opts);
  } catch (e) {
    if (e instanceof ServiceError) { console.error(e.message); return 1; }
    throw e;
  }
}
