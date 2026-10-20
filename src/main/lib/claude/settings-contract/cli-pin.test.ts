import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareVersionQuad, parseVersionQuad } from '../../auto-updater';
import { claudeVersionSupportsUltra, claudeVersionSupportsXhigh } from '../bundled-claude-version';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const readJson = (relative: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));

const PINNED_CLI: string = readJson('scripts/binaries/claude-cli-version.json').version;
const SDK_CLI: string = readJson(
  'node_modules/@anthropic-ai/claude-agent-sdk/package.json',
).claudeCodeVersion;

// The settings contract only knows the keys of the SDK's paired CLI. 25 admits the 0.4.0 CLI
// (23 ahead) and forces an SDK bump with the next CLI bump.
const MAX_CLI_AHEAD_OF_SDK = 25;
// The first CLI that ships `claude-haiku-5-5`, which the model catalog offers.
const CATALOG_MODEL_FLOOR = '2.1.293';

function patchParts(version: string): [string, number] {
  const match = /^(\d+\.\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Not a plain X.Y.Z version: ${version}`);
  return [match[1], Number(match[2])];
}

/** Why the pin cannot ship with this SDK, or null when it can. */
function pairingProblem(cli: string, sdkCli: string): string | null {
  const [cliLine, cliPatch] = patchParts(cli);
  const [sdkLine, sdkPatch] = patchParts(sdkCli);
  if (cliLine !== sdkLine) return `CLI ${cli} is on another release line than the SDK's ${sdkCli}`;
  if (cliPatch < sdkPatch) return `CLI ${cli} is older than the SDK's paired CLI ${sdkCli}`;
  if (cliPatch - sdkPatch > MAX_CLI_AHEAD_OF_SDK) {
    return `CLI ${cli} is ${cliPatch - sdkPatch} patches ahead of the SDK's ${sdkCli} (max ${MAX_CLI_AHEAD_OF_SDK}): bump @anthropic-ai/claude-agent-sdk`;
  }
  return null;
}

/** Whether a CLI ships every model the catalog offers. */
function meetsCatalogFloor(version: string): boolean {
  return compareVersionQuad(parseVersionQuad(version), parseVersionQuad(CATALOG_MODEL_FLOOR)) >= 0;
}

describe('pinned Claude CLI', () => {
  it('pairs with the installed Agent SDK', () => {
    expect(pairingProblem(PINNED_CLI, SDK_CLI)).toBeNull();
  });

  it('refuses a CLI older than the SDK, or too far ahead of it', () => {
    expect(pairingProblem('2.1.277', '2.1.278')).toContain('older than');
    expect(pairingProblem('2.1.304', '2.1.278')).toContain('26 patches ahead');
    expect(pairingProblem('2.2.0', '2.1.278')).toContain('another release line');
    expect(pairingProblem('2.1.303', '2.1.278')).toBeNull();
    expect(pairingProblem('2.1.278', '2.1.278')).toBeNull();
  });

  it('compares the catalog floor by whole version, so a new release line still meets it', () => {
    expect(meetsCatalogFloor('2.1.293')).toBe(true);
    expect(meetsCatalogFloor('2.1.292')).toBe(false);
    expect(meetsCatalogFloor('2.2.0')).toBe(true);
    expect(meetsCatalogFloor('3.0.0')).toBe(true);
    expect(meetsCatalogFloor('2.0.999')).toBe(false);
  });

  it('supports every effort level and catalog model Frink offers', () => {
    expect(claudeVersionSupportsXhigh(PINNED_CLI)).toBe(true);
    expect(claudeVersionSupportsUltra(PINNED_CLI)).toBe(true);
    expect(meetsCatalogFloor(PINNED_CLI)).toBe(true);
  });
});
