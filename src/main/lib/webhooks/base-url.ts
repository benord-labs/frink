import * as path from 'node:path';
import { z } from 'zod';
import { readConfigFile, writeConfigFile } from './config-file-io';
import { frinkUserHome } from '../platform/frink-home';

/** Unassigned in the IANA dynamic range, beside the debug-ingest port, so a tunnel address
 * survives a restart. Held by another instance ⇒ the OS picks one and boot reports it here. */
export const LOOPBACK_INGRESS_PORT = 49238;

/** The relay Frink runs for anyone who has not brought their own: best-effort and revocable, and
 * the single place to edit when it moves. */
export const FRINK_RELAY_BASE_URL = 'https://relay.frink.dev';

/** The only hosts plaintext is safe to: nothing leaves the machine. `[::1]` is how `URL` spells
 * the v6 literal back. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An address reduced to the bare origin every minted URL hangs off, or null: a path would land
 * inside each address a vendor is handed, and plaintext off this machine puts the keys on the wire. */
export function normalizeIngressBaseUrl(raw: string | null | undefined): string | null {
  try {
    const url = new URL(raw?.trim() ?? '');
    const plaintextToSelf = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
    return url.protocol === 'https:' || plaintextToSelf ? url.origin : null;
  } catch {
    return null;
  }
}

/** A row a move could not take with it, and the base it is therefore still armed on — where its
 * subscription has to be deleted, whatever has been recorded as the current base since. */
export type StrandedEndpoint = { id: string; armedOn: string | null };

let loopback = `http://127.0.0.1:${LOOPBACK_INGRESS_PORT}`;
let mintedAgainst: string | null = null;
let stranded: StrandedEndpoint[] = [];

function settingPath(): string {
  return path.join(frinkUserHome(), '.frink', 'webhooks', 'config.json');
}

/** Where webhooks reach this Frink, in every build alike: FRINK_WEBHOOK_BASE_URL unset is Frink's
 * relay, blank is local-only, and a refused address resolves to nothing rather than to the relay. */
export function ingressBaseUrl(): string | null {
  const configured = process.env.FRINK_WEBHOOK_BASE_URL;
  return configured === undefined ? FRINK_RELAY_BASE_URL : normalizeIngressBaseUrl(configured);
}

/** The variable's value when it is set, refused, and therefore the reason this machine has no
 * address at all — which boot says once, since nothing in the app asks for one. */
export function rejectedIngressEnv(): string | null {
  const configured = process.env.FRINK_WEBHOOK_BASE_URL?.trim();
  if (!configured) return null;
  return normalizeIngressBaseUrl(configured) === null ? configured : null;
}

/** The file on disk, read at its boundary: what the last relay move left, and nothing else. */
const savedFile = z.object({
  mintedAgainst: z.string().trim().nullish(),
  // `armedOn` is null only for a row stranded before this machine had ever recorded a base.
  stranded: z.array(z.object({ id: z.string(), armedOn: z.string().nullable() })).nullish(),
});

/** Read the move record into memory once, so minting and claiming resolve without a file read. */
export async function loadRelayMoveRecord(): Promise<void> {
  try {
    const file = savedFile.parse(JSON.parse(await readConfigFile(settingPath())));
    mintedAgainst = file.mintedAgainst ?? null;
    stranded = file.stranded ?? [];
  } catch {
    mintedAgainst = null;
    stranded = [];
  }
}

/** The base the addresses on this machine were last minted against. */
export function mintedAgainstBaseUrl(): string | null {
  return mintedAgainst;
}

/** The addresses the last move could not take with it, which the next one retries first. */
export function strandedEndpoints(): readonly StrandedEndpoint[] {
  return stranded;
}

/** What the last move left: the base every address now hangs off, so a later boot on a different
 * one re-mints once, and the rows that did not make it, which are retried until they do. */
export async function setRelayMoveOutcome(
  baseUrl: string | null,
  strandedRows: readonly StrandedEndpoint[],
): Promise<void> {
  const next = [...strandedRows];
  const file: z.infer<typeof savedFile> = { mintedAgainst: baseUrl, stranded: next };
  await writeConfigFile(settingPath(), `${JSON.stringify(file, null, 2)}\n`);
  mintedAgainst = baseUrl;
  stranded = next;
}

export function setLoopbackIngressPort(port: number): void {
  loopback = `http://127.0.0.1:${port}`;
}

/** The base every address this machine mints hangs off. Without a relay it is this machine's own
 * door, which proves the path but is not somewhere a vendor on the internet can deliver. */
export function localIngressBaseUrl(): string {
  return ingressBaseUrl() ?? loopback;
}
