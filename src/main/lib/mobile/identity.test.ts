import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadDesktopIdentity, resetDesktopIdentity, routeOf } from './identity';

let directory: string;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frink-mobile-identity-'));
  file = join(directory, 'mobile-identity.json');
});
afterEach(() => rm(directory, { recursive: true, force: true }));

it('keeps one identity across loads and stores only secrets, owner-readable', async () => {
  const first = await loadDesktopIdentity(file);
  const again = await loadDesktopIdentity(file);
  expect(again.routeKey).toBe(first.routeKey);
  expect(again.keyPair.publicKey).toEqual(first.keyPair.publicKey);
  expect(first.route).toBe(routeOf(first.routeKey));
  expect(Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort()).toEqual([
    'routeKey',
    'secretKey',
  ]);
});

it('mints a fresh identity after a reset or from an unreadable file', async () => {
  const first = await loadDesktopIdentity(file);
  await resetDesktopIdentity(file);
  const second = await loadDesktopIdentity(file);
  expect(second.routeKey).not.toBe(first.routeKey);
  await writeFile(file, '{"routeKey":"nope"}');
  expect((await loadDesktopIdentity(file)).routeKey).not.toBe(second.routeKey);
});

it('refuses to rotate the identity when the file cannot be read', async () => {
  await mkdir(file);
  await expect(loadDesktopIdentity(file)).rejects.toThrow();
});
