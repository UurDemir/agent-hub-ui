// Sends a message to a running Claude Code session through its local messaging
// socket (the one other Claude sessions use to message it). Each session lists the
// socket as `messagingSocketPath` in ~/.claude/sessions/<pid>.json and publishes the
// token peers must present in ~/.claude/sessions/<pid>.<sha256(socket)>.key.
// The protocol is undocumented: one JSON line to authenticate, then one per message.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MAX_MESSAGE = 20000;
const KEY_MAX_BYTES = 4096;
const TIMEOUT_MS = 5000;

// Claude Code names the key file after the socket path in canonical form:
// lowercased on Windows (named pipes are case-insensitive), resolved elsewhere.
export function keyHash(sock, platform = process.platform) {
  const canon = platform === 'win32' ? sock.toLowerCase() : path.resolve(sock);
  return createHash('sha256').update(canon).digest('hex');
}

export function readPeerToken(dir, pid, sock, platform = process.platform) {
  const hash = keyHash(sock, platform);
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }
  const own = `${pid}.${hash}.key`;
  const file = files.includes(own) ? own : files.find((f) => /^\d+\.[0-9a-f]{64}\.key$/.test(f) && f.endsWith(`.${hash}.key`));
  if (!file) return null;
  try {
    const p = path.join(dir, file);
    if (fs.statSync(p).size > KEY_MAX_BYTES) return null;
    const token = JSON.parse(fs.readFileSync(p, 'utf8')).peerToken;
    return typeof token === 'string' && /^[0-9a-f]{32}$/.test(token) ? token : null;
  } catch { return null; }
}

export function frames(token, sessionId, text) {
  return JSON.stringify({ type: 'auth', token }) + '\n'
    + JSON.stringify({
      type: 'user',
      // Claude Code drops the message if this doesn't match, so a reused pid can't misdeliver it.
      session_id: sessionId,
      uuid: randomUUID(),
      from: 'agent-hub',
      message: { role: 'user', content: text },
    }) + '\n';
}

// info is the session's ~/.claude/sessions/<pid>.json record.
export function sendToSession(dir, info, text) {
  const sock = info?.messagingSocketPath;
  if (typeof sock !== 'string' || !sock) return Promise.reject(new Error('This session has no messaging socket (older Claude Code, or messaging is off).'));
  const token = readPeerToken(dir, info.pid, sock);
  if (!token) return Promise.reject(new Error('No messaging key found for this session.'));
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    const timer = setTimeout(() => c.destroy(new Error('Timed out talking to the session.')), TIMEOUT_MS);
    c.once('connect', () => c.end(frames(token, info.sessionId, text)));
    // net errors name the socket path; report only the code.
    c.on('error', (e) => { clearTimeout(timer); reject(e.code ? new Error(`Could not reach the session (${e.code}).`) : e); });
    c.once('close', (hadError) => { clearTimeout(timer); if (!hadError) resolve(); });
  });
}
