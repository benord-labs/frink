#!/usr/bin/env node
/**
 * Dev warning: tell the developer the bundled Codex is unusable BEFORE they start a chat.
 *
 * `resources/` is gitignored, so pulling a commit that touches `patches/codex` updates the tracked
 * manifest and leaves the locally built binary behind. The runtime resolver then refuses it
 * (src/main/lib/agent-runner/codex/codex-binary.ts) and the failure surfaces mid-conversation.
 *
 * Never fatal: only Codex is affected, and the remedy is a cargo compile that can run to an hour
 * on a cold cache — blocking `dev` behind that would cost more than the drift.
 * Caller: `dev`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexVersionStamp, platformKey, validateManifest } from './build-codex-frink.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REBUILD = '`bun run codex:build` (minutes with a warm cargo cache, an hour or more cold)';

/**
 * Compare the stamp beside the bundled binary against the one the patch manifest implies.
 * Returns null when they agree, else both values — `actual: null` means no binary is present
 * here at all, which is a different problem with a different remedy.
 */
export function codexStampDrift(root = ROOT, read = readFileSync) {
  const manifest = validateManifest(
    JSON.parse(read(join(root, 'patches/codex/manifest.json'), 'utf8')),
  );
  const expected = codexVersionStamp(manifest);
  try {
    const actual = read(join(root, 'resources/bin', platformKey(), 'CODEX_VERSION'), 'utf8').trim();
    return actual === expected ? null : { expected, actual };
  } catch {
    return { expected, actual: null };
  }
}

export function driftWarning(drift) {
  if (drift.actual === null) {
    return (
      `[ensure-codex-binary] No bundled Codex in this checkout (resources/bin/${platformKey()}/).\n` +
      '  resources/ is gitignored, so a fresh clone or worktree never has one. Symlink or copy it\n' +
      `  from your main checkout, or run ${REBUILD}.\n` +
      '  Codex chats will fail until then; every other surface is unaffected.'
    );
  }
  return (
    '[ensure-codex-binary] Bundled Codex was built from an older patch than this app expects.\n' +
    `  expected ${drift.expected}\n` +
    `  on disk  ${drift.actual}\n` +
    `  Run ${REBUILD}. Codex chats will fail until then; every other surface is unaffected.`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const drift = codexStampDrift();
    if (drift) console.warn(driftWarning(drift));
  } catch (error) {
    // Exiting non-zero here would sever the `&&` chain and stop `dev` from starting at all.
    console.warn(`[ensure-codex-binary] check skipped: ${error.message}`);
  }
}
