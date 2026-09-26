import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRINK_RELAY_BASE_URL,
  ingressBaseUrl,
  loadRelayMoveRecord,
  localIngressBaseUrl,
  LOOPBACK_INGRESS_PORT,
  mintedAgainstBaseUrl,
  rejectedIngressEnv,
  setRelayMoveOutcome,
  strandedEndpoints,
} from './base-url';

const OWN_RELAY = 'https://relay.example.com';
const ENV_RELAY = 'http://127.0.0.1:8787';

let home: string;

function configFile(): string {
  return path.join(home, '.frink', 'webhooks', 'config.json');
}

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'frink-ingress-'));
  vi.stubEnv('FRINK_HOME', home);
  vi.stubEnv('FRINK_WEBHOOK_BASE_URL', '');
  // The move record lives in module memory, so each case starts from an empty home.
  await loadRelayMoveRecord();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('ingress base url', () => {
  it('is local-only with a blank environment address, and mints on loopback', () => {
    expect(ingressBaseUrl()).toBeNull();
    expect(localIngressBaseUrl()).toBe(`http://127.0.0.1:${LOOPBACK_INGRESS_PORT}`);
  });

  it.each(['development', 'production'])(
    "falls back to Frink's own relay in a %s build, which the environment still overrides",
    (mode) => {
      vi.stubEnv('MODE', mode);
      vi.stubEnv('FRINK_WEBHOOK_BASE_URL', undefined);

      expect(ingressBaseUrl()).toBe(FRINK_RELAY_BASE_URL);

      vi.stubEnv('FRINK_WEBHOOK_BASE_URL', ENV_RELAY);
      expect(ingressBaseUrl()).toBe(ENV_RELAY);
    },
  );
});

/** The address is pasted into a variable as often as it is typed, and the keys ride on it. */
describe('the address a user can give this machine', () => {
  it('keeps only the origin, so a copied path never lands inside every trigger address', () => {
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', 'https://relay.example.com/');
    expect(ingressBaseUrl()).toBe(OWN_RELAY);

    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', 'https://relay.example.com/hooks?q=1#f');
    expect(ingressBaseUrl()).toBe(OWN_RELAY);
  });

  it('refuses plaintext anywhere but this machine, where the subscribe keys would be on the wire', () => {
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', 'http://relay.example.com');
    expect(ingressBaseUrl()).toBeNull();

    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', ENV_RELAY);
    expect(ingressBaseUrl()).toBe(ENV_RELAY);
  });

  it('refuses an environment address rather than falling through to the default', () => {
    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', 'http://relay.example.com');

    // Someone who named their own relay must never be moved onto Frink's without being told: that
    // mints every key for an operator they did not choose. No address at all is the honest answer.
    expect(ingressBaseUrl()).toBeNull();
    expect(rejectedIngressEnv()).toBe('http://relay.example.com');
  });

  it('names no rejection when the variable is blank or legal', () => {
    expect(rejectedIngressEnv()).toBeNull();

    vi.stubEnv('FRINK_WEBHOOK_BASE_URL', ENV_RELAY);
    expect(rejectedIngressEnv()).toBeNull();
  });
});

describe('what the last move left', () => {
  it('survives a restart, and the rows a move could not take are still owed one', async () => {
    await setRelayMoveOutcome(OWN_RELAY, [{ id: 'endpoint-1', armedOn: ENV_RELAY }]);

    await loadRelayMoveRecord();

    expect(mintedAgainstBaseUrl()).toBe(OWN_RELAY);
    // A row a move could not take is owed a retry on every later boot, and its subscription is
    // still on the base it was armed on rather than the one recorded as current beside it.
    expect(strandedEndpoints()).toEqual([{ id: 'endpoint-1', armedOn: ENV_RELAY }]);
  });

  it('is all the file is read for: an address an older build wrote there names nothing now', async () => {
    mkdirSync(path.dirname(configFile()), { recursive: true });
    writeFileSync(
      configFile(),
      JSON.stringify({ baseUrl: OWN_RELAY, mintedAgainst: OWN_RELAY }),
      'utf-8',
    );

    await loadRelayMoveRecord();

    expect(ingressBaseUrl()).toBeNull();
    expect(mintedAgainstBaseUrl()).toBe(OWN_RELAY);
  });
});
