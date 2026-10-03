import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import nacl from 'tweetnacl';
import { z } from 'zod';
import {
  decodeKey,
  encodeKey,
  generateDesktopKeyPair,
  type ChannelKeyPair,
} from '../../../shared/lib/mobile-channel';

/** `routeKey` claims the relay route (the relay learns it: reachability, never confidentiality);
 * `keyPair` is the channel key the phone pins from the QR, its secret never leaving this file. */
export type DesktopIdentity = { routeKey: string; route: string; keyPair: ChannelKeyPair };

const fileSchema = z.object({
  routeKey: z.string().regex(/^[a-f0-9]{64}$/),
  secretKey: z.string(),
});

/** The public routing id: sha256 of the route key's hex text, as the relay computes it. */
export function routeOf(routeKey: string): string {
  return createHash('sha256').update(routeKey, 'utf8').digest('hex');
}

function identityOf(routeKey: string, keyPair: ChannelKeyPair): DesktopIdentity {
  return { routeKey, route: routeOf(routeKey), keyPair };
}

async function create(filePath: string): Promise<DesktopIdentity> {
  const routeKey = randomBytes(32).toString('hex');
  const keyPair = generateDesktopKeyPair();
  const text = JSON.stringify({ routeKey, secretKey: encodeKey(keyPair.secretKey) });
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${text}\n`, { mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return identityOf(routeKey, keyPair);
}

async function readSaved(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    // A transient read failure must not rotate the identity and strand every paired phone.
    throw error;
  }
}

/** Reads this desktop's identity, minting one on first use or when the file is corrupt. */
export async function loadDesktopIdentity(filePath: string): Promise<DesktopIdentity> {
  const text = await readSaved(filePath);
  if (text === null) return create(filePath);
  try {
    const saved = fileSchema.parse(JSON.parse(text));
    const secretKey = decodeKey(saved.secretKey);
    if (!secretKey) throw new Error('Unreadable mobile identity');
    // The public key is derived, never stored, so the two halves cannot disagree.
    return identityOf(saved.routeKey, nacl.box.keyPair.fromSecretKey(secretKey));
  } catch {
    return create(filePath);
  }
}

/** Forgets the identity, so every QR and every phone's pinned key stops reaching this desktop. */
export async function resetDesktopIdentity(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}
