import { describe, expect, it } from 'vitest';
import threadItems from '../../patches/codex/thread-item-variants.json';
import { FRINK_HOST_TOOL_PERMISSION_VERSION } from '../../src/main/lib/agent-runner/codex/codex-host-permissions';
import {
  assertHandshakeResult,
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

const manifest = {
  version: 'rust-v0.155.1',
  tagObject: '4e21628f9ec9ee656650cd2b62ef92225725b5ac',
  commit: 'be2951ea34f0d295ed0becf97079f92fa5f6950e',
  sourceArchiveSha256: 'b9e18d40d322586913e94d6747f3f934922c4f5130eb5a349ba019c57b83dad8',
  normalizedCargoLockSha256: 'df88a71b82843c6f092610fb07589f7a40032ddc25f50718354546ca541eb9b7',
  rust: '1.95.0',
  patch: 'frink-host-tool-permission-v1.patch',
  patchSha256: '0ef3a323e435ad3868d7942ed387b77a07a59a6e8551392bd995f7171fd3eab2',
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
    expect(codexVersionStamp(manifest)).toBe('rust-v0.155.1+frink.0ef3a323e435');
    expect(codexVersionStamp({ ...manifest, patchSha256: 'a'.repeat(64) })).toBe(
      'rust-v0.155.1+frink.aaaaaaaaaaaa',
    );
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
