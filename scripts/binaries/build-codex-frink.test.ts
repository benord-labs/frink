import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import pinnedManifestJson from '../../patches/codex/manifest.json';
import threadItems from '../../patches/codex/thread-item-variants.json';
import { FRINK_HOST_TOOL_PERMISSION_VERSION } from '../../src/main/lib/agent-runner/codex/codex-host-permissions';
import {
  assertHandshakeResult,
  assertPinnedPatch,
  assertMcpReplaceConsumed,
  assertPinnedThreadItems,
  codexVersionStamp,
  normalizeWorkspaceVersions,
  parseBuildArguments,
  parseInitializeResult,
  parseThreadItemVariants,
  platformKey,
  releaseTargetKeys,
  validateManifest,
  validateRemoteTagOutput,
} from './build-codex-frink.mjs';

const ROOT_DIR = path.resolve(__dirname, '..', '..');

const manifest = {
  version: 'rust-v0.155.1',
  tagObject: '4e21628f9ec9ee656650cd2b62ef92225725b5ac',
  commit: 'be2951ea34f0d295ed0becf97079f92fa5f6950e',
  sourceArchiveSha256: 'b9e18d40d322586913e94d6747f3f934922c4f5130eb5a349ba019c57b83dad8',
  normalizedCargoLockSha256: 'df88a71b82843c6f092610fb07589f7a40032ddc25f50718354546ca541eb9b7',
  rust: '1.95.0',
  patch: 'frink-host-tool-permission-v1.patch',
  patchSha256: '5af8795f63311f953a943b8f056058cdde90528b6cecf5acf220d75ff1447540',
  upstream: 'https://github.com/openai/codex',
};

describe('permission-aware Codex source build', () => {
  it('accepts only the pinned source identity and toolchain', () => {
    expect(validateManifest(manifest)).toBe(manifest);
    expect(() => validateManifest({ ...manifest, rust: 'stable' })).toThrow(
      'Invalid pinned Codex source manifest field: rust',
    );
    expect(() => validateManifest({ ...manifest, commit: '0'.repeat(40) })).toThrow(
      'Invalid pinned Codex source manifest field: commit',
    );
    expect(() => validateManifest({ ...manifest, patchSha256: '0'.repeat(64) })).toThrow(
      'Invalid pinned Codex source manifest field: patchSha256',
    );
  });

  it('requires the exact annotated tag object and peeled commit from upstream', () => {
    const output = `${manifest.tagObject}\trefs/tags/${manifest.version}\n${manifest.commit}\trefs/tags/${manifest.version}^{}\n`;
    expect(() => validateRemoteTagOutput(manifest, output)).not.toThrow();
    expect(() =>
      validateRemoteTagOutput(manifest, output.replace(manifest.commit, '0'.repeat(40))),
    ).toThrow('Pinned Codex tag identity does not match upstream');
  });

  it('normalizes only Cargo local placeholder versions for locked builds', () => {
    expect(normalizeWorkspaceVersions('version = "0.0.0"\nversion = "1.2.3"\n', '0.155.1')).toBe(
      'version = "0.155.1"\nversion = "1.2.3"\n',
    );
  });

  it('selects the current native artifact key without cross-platform fallback', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformKey('win32', 'x64')).toBe('win32-x64');
  });

  it('builds both packaged macOS architectures and only the native target elsewhere', () => {
    expect(releaseTargetKeys('darwin', 'arm64')).toEqual(['darwin-arm64', 'darwin-x64']);
    expect(releaseTargetKeys('linux', 'x64')).toEqual(['linux-x64']);
  });

  it('parses explicit CI targets and the provider regression-test flag', () => {
    expect(parseBuildArguments(['--target', 'darwin-x64', '--test'])).toEqual({
      targetKeys: ['darwin-x64'],
      runProviderTests: true,
    });
    expect(() => parseBuildArguments(['--target'])).toThrow('--target requires a platform key');
    expect(() => parseBuildArguments(['--all'])).toThrow('Unknown Codex build argument');
  });
});

describe('codexVersionStamp', () => {
  it('carries the patch identity so a stale bundled binary is detectable at runtime', () => {
    expect(codexVersionStamp(manifest)).toBe('rust-v0.155.1+frink.5af8795f6331');
    expect(codexVersionStamp({ ...manifest, patchSha256: 'a'.repeat(64) })).toBe(
      'rust-v0.155.1+frink.aaaaaaaaaaaa',
    );
  });
});

describe('pinned Codex patch bytes', () => {
  const pinnedManifest = validateManifest(pinnedManifestJson);
  const patchRelPath = `patches/codex/${pinnedManifest.patch}`;
  const patchBytes = fs.readFileSync(path.join(ROOT_DIR, patchRelPath));

  // The hash checks below see this OS's checkout, which never converts on macOS/Linux; only the
  // attribute proves a Windows checkout (core.autocrlf=true) leaves the bytes alone.
  it('is checked out without line-ending conversion on every OS', () => {
    const attr = execFileSync('git', ['check-attr', 'text', '--', patchRelPath], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    });
    expect(attr.trim()).toBe(`${patchRelPath}: text: unset`);
  });

  it('accepts the committed LF patch the manifest pins', () => {
    expect(patchBytes.includes(0x0d)).toBe(false);
    expect(() => assertPinnedPatch(pinnedManifest, patchBytes)).not.toThrow();
  });

  it('names a CRLF checkout and its remedy instead of a bare mismatch', () => {
    const crlf = Buffer.from(patchBytes.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
    // The remedy must restore from HEAD: after `git rm --cached` the index is empty, so a plain
    // `git checkout --` has nothing to restore and leaves the CRLF bytes plus a staged deletion.
    expect(() => assertPinnedPatch(pinnedManifest, crlf)).toThrow(
      'git rm -rq --cached patches/codex && git checkout HEAD -- patches/codex',
    );
    expect(() => assertPinnedPatch(pinnedManifest, crlf)).toThrow(/SHA-256 mismatch.*CRLF/);
  });

  it('rejects other altered bytes without blaming line endings', () => {
    const altered = Buffer.concat([patchBytes, Buffer.from('\n')]);
    expect(() => assertPinnedPatch(pinnedManifest, altered)).toThrow(
      'Codex provider patch SHA-256 mismatch',
    );
    expect(() => assertPinnedPatch(pinnedManifest, altered)).not.toThrow(/CRLF/);
  });
});

describe('pinned ThreadItem union', () => {
  // The shape ts-rs emits: one `{ "type": "<tag>" ... }` member per variant, some intersected.
  const bindings =
    'export type ThreadItem = { "type": "userMessage", id: string, } | ' +
    '{ "type": "reasoning", id: string, } | { "type": "webSearch" } & WebSearchItem;';

  it('reads every variant tag out of upstream generated bindings', () => {
    expect(parseThreadItemVariants(bindings)).toEqual(['reasoning', 'userMessage', 'webSearch']);
  });

  it('accepts a fixture that still matches upstream', () => {
    const declared = {
      version: manifest.version,
      variants: ['reasoning', 'userMessage', 'webSearch'],
    };
    expect(() =>
      assertPinnedThreadItems(manifest, declared, parseThreadItemVariants(bindings)),
    ).not.toThrow();
  });

  it('names the variants a bump added, so each one gets classified', () => {
    const declared = { version: manifest.version, variants: ['reasoning', 'userMessage'] };
    expect(() =>
      assertPinnedThreadItems(manifest, declared, parseThreadItemVariants(bindings)),
    ).toThrow('added: webSearch');
  });

  it('names the variants a bump removed, so a dead denylist entry is not kept forever', () => {
    const declared = {
      version: manifest.version,
      variants: ['reasoning', 'retired', 'userMessage', 'webSearch'],
    };
    expect(() =>
      assertPinnedThreadItems(manifest, declared, parseThreadItemVariants(bindings)),
    ).toThrow('removed: retired');
  });

  it('rejects a fixture left behind on the previous pin', () => {
    const declared = { version: 'rust-v0.149.0', variants: [] };
    expect(() => assertPinnedThreadItems(manifest, declared, [])).toThrow(
      'thread-item-variants.json pins rust-v0.149.0, manifest pins rust-v0.155.1',
    );
  });

  it('holds for the real pinned fixture and the union Frink shipped against', () => {
    expect(() =>
      assertPinnedThreadItems(manifest, threadItems, threadItems.variants),
    ).not.toThrow();
    expect(threadItems.variants).toContain('functionCallOutput');
  });
});

describe('built-binary handshake', () => {
  const good = {
    userAgent:
      'frink-build-check/0.155.1 (Mac OS 26.5.1; arm64) ghostty/1.3.1 (frink-build-check; 0)',
    capabilities: { frinkHostToolPermission: FRINK_HOST_TOOL_PERMISSION_VERSION },
  };

  it('finds the initialize reply among the notifications sharing stdout', () => {
    const transcript = [
      JSON.stringify({ method: 'configWarning', params: {} }),
      '',
      JSON.stringify({ id: 1, result: good }),
    ].join('\n');
    expect(parseInitializeResult(transcript)).toEqual(good);
    expect(parseInitializeResult(JSON.stringify({ method: 'configWarning' }))).toBeNull();
  });

  it('accepts a binary that answers with the capability the app requires at runtime', () => {
    expect(() => assertHandshakeResult(manifest, good)).not.toThrow();
  });

  it('rejects a stock or unpatched Codex, whatever the stamp beside it says', () => {
    expect(() => assertHandshakeResult(manifest, { ...good, capabilities: {} })).toThrow(
      'does not advertise frinkHostToolPermission',
    );
    expect(() => assertHandshakeResult(manifest, null)).toThrow(
      'does not advertise frinkHostToolPermission',
    );
  });

  it('rejects a host-permission version the app cannot speak', () => {
    expect(() =>
      assertHandshakeResult(manifest, { ...good, capabilities: { frinkHostToolPermission: 2 } }),
    ).toThrow('does not advertise frinkHostToolPermission v1');
  });

  it('reads the version Codex reports, never the client version echoed back in the same string', () => {
    expect(() =>
      assertHandshakeResult(manifest, {
        ...good,
        userAgent: 'frink-build-check/0.149.0 (Mac OS) ghostty/1.3.1 (frink-build-check; 0.155.1)',
      }),
    ).toThrow('expected it to start "frink-build-check/0.155.1 "');
  });

  it('rejects a binary reporting a version other than the pin (a stale copy under a fresh stamp)', () => {
    expect(() =>
      assertHandshakeResult(manifest, { ...good, userAgent: 'frink-build-check/0.149.0 (Mac OS)' }),
    ).toThrow('expected it to start "frink-build-check/0.155.1 "');
  });
});

describe('empty CODEX_HOME MCP replacement', () => {
  it('accepts an MCP listing that loaded config with the sentinel consumed', () => {
    expect(() => assertMcpReplaceConsumed('No MCP servers configured yet.\n')).not.toThrow();
  });

  it('rejects a listing that surfaced the sentinel as a server', () => {
    expect(() =>
      assertMcpReplaceConsumed('Name             Command\n__frink_replace  -\n'),
    ).toThrow('__frink_replace');
  });

  it('rejects a config-load failure reported on stdout', () => {
    expect(() => assertMcpReplaceConsumed('Error: failed to load configuration')).toThrow(
      'did not consume',
    );
  });
});
