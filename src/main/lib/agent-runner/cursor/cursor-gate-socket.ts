import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { JsonValue } from '../../../../shared/types/permissions';

const MAX_BODY_BYTES = 1024 * 1024;
// The gate gets the body as sent, so it can refuse keys a JSON parse would drop.
type GateAnswer = (body: string) => Promise<JsonValue>;
const DENY = {
  permission: 'deny',
  user_message: "Frink couldn't read Cursor's request, so it blocked it.",
};

/** One hook call's reply as JSON; anything Frink cannot read or answer is denied. */
async function reply(req: IncomingMessage, answer: GateAnswer) {
  const deny = JSON.stringify(DENY);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    }
    if (size > MAX_BODY_BYTES) return deny;
    const answered = await answer(Buffer.concat(chunks).toString('utf8'));
    return answered === undefined ? deny : JSON.stringify(answered);
  } catch {
    return deny;
  }
}

async function closeGate(server: Server, gateDir: string) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(gateDir, { recursive: true, force: true });
}

/** Listens for one turn's hook calls in a fresh private folder; unlock the folder before `close`. */
export async function openGateSocket(answer: GateAnswer) {
  const gateDir = await mkdtemp(path.join(os.tmpdir(), 'fcg-'));
  const socketPath = path.join(gateDir, 'g.sock');
  const server = createServer((req, res) => {
    void reply(req, answer).then((body) => {
      res.setHeader('content-type', 'application/json');
      res.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  let closed: Promise<void> | undefined;
  // A failed close (its folder still locked) can be retried.
  const close = () =>
    (closed ??= closeGate(server, gateDir).catch((error: Error) => {
      closed = undefined;
      throw error;
    }));
  return { gateDir, socketPath, close };
}
