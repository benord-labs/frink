import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import pinnedManifest from '../../patches/codex/manifest.json';
import threadItems from '../../patches/codex/thread-item-variants.json';
import { FRINK_HOST_TOOL_PERMISSION_VERSION } from '../../src/main/lib/agent-runner/codex/codex-host-permissions';
import {
  assertHandshakeResult,
  assertMcpReplaceConsumed,
  assertPinnedThreadItems,
  codexVersionStamp,
  normalizeCargoLock,
  normalizeWorkspaceVersions,
  parseBuildArguments,
  parseInitializeResult,
  parseThreadItemVariants,
  platformKey,
  releaseTargetKeys,
  runInitializeHandshake,
  validateManifest,
  validateRemoteTagOutput,
} from './build-codex-frink.mjs';
import { sha256File } from './http-download.mjs';

const manifest = {
  version: 'rust-v0.155.1',
  tagObject: '4e21628f9ec9ee656650cd2b62ef92225725b5ac',
  commit: 'be2951ea34f0d295ed0becf97079f92fa5f6950e',
  sourceArchiveSha256: 'b9e18d40d322586913e94d6747f3f934922c4f5130eb5a349ba019c57b83dad8',
  normalizedCargoLockSha256: 'df88a71b82843c6f092610fb07589f7a40032ddc25f50718354546ca541eb9b7',
  rust: '1.95.0',
  patch: 'frink-host-tool-permission-v1.patch',
  // Pinned once, in the manifest: the script and these tests read it rather than repeat it.
  patchSha256: pinnedManifest.patchSha256,
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
  });

  it('takes the patch identity from the manifest but rejects one that is not a SHA-256', () => {
    expect(validateManifest({ ...manifest, patchSha256: 'a'.repeat(64) }).patchSha256).toBe(
      'a'.repeat(64),
    );
    for (const patchSha256 of ['deadbeef', 'A'.repeat(64), `${'a'.repeat(64)}0`, undefined]) {
      expect(() => validateManifest({ ...manifest, patchSha256 })).toThrow(
        'Invalid pinned Codex source manifest field: patchSha256',
      );
    }
  });

  it('pins the bytes of the committed patch, so a hand edit fails here and not an hour into a build', () => {
    const patchPath = path.join(__dirname, '../../patches/codex', pinnedManifest.patch);
    expect(sha256File(patchPath)).toBe(pinnedManifest.patchSha256);
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
      testOnly: false,
    });
    expect(() => parseBuildArguments(['--target'])).toThrow('--target requires a platform key');
    expect(() => parseBuildArguments(['--all'])).toThrow('Unknown Codex build argument');
  });

  it('runs the provider tests alone, without building a binary, for the parallel CI job', () => {
    expect(parseBuildArguments(['--test-only'])).toEqual({
      targetKeys: [],
      runProviderTests: true,
      testOnly: true,
    });
  });

  it('refuses --test-only with a target, which would silently skip the build it names', () => {
    expect(() => parseBuildArguments(['--test-only', '--target', 'linux-x64'])).toThrow(
      '--test-only builds no binary, so it cannot take --target',
    );
    expect(() => parseBuildArguments(['--target', 'linux-x64', '--test-only'])).toThrow(
      '--test-only builds no binary',
    );
  });
});

describe('normalizeCargoLock', () => {
  const pristine = 'name = "codex-core"\nversion = "0.0.0"\n';
  const normalized = 'name = "codex-core"\nversion = "0.155.1"\n';

  function sourceWithLock(lock: string) {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-codex-lock-'));
    fs.mkdirSync(path.join(sourceDir, 'codex-rs'));
    fs.writeFileSync(path.join(sourceDir, 'codex-rs', 'Cargo.lock'), lock);
    return sourceDir;
  }

  function pinnedTo(lock: string) {
    const scratch = sourceWithLock(lock);
    const sha = sha256File(path.join(scratch, 'codex-rs', 'Cargo.lock'));
    fs.rmSync(scratch, { recursive: true, force: true });
    return { ...manifest, normalizedCargoLockSha256: sha };
  }

  it('rewrites the lockfile in place, and accepts one a previous run already rewrote', () => {
    const sourceDir = sourceWithLock(pristine);
    try {
      normalizeCargoLock(sourceDir, pinnedTo(normalized));
      expect(fs.readFileSync(path.join(sourceDir, 'codex-rs', 'Cargo.lock'), 'utf8')).toBe(
        normalized,
      );
      expect(() => normalizeCargoLock(sourceDir, pinnedTo(normalized))).not.toThrow();
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it('refuses a lockfile that differs from the pin once normalised', () => {
    const sourceDir = sourceWithLock(`${pristine}[[package]]\n`);
    try {
      expect(() => normalizeCargoLock(sourceDir, pinnedTo(normalized))).toThrow(
        'Normalized Cargo.lock SHA-256 mismatch',
      );
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});

describe('command lines', () => {
  const run = (script: string, ...args: string[]) =>
    spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' });

  it('runs the patch workspace modes and fails with their message', () => {
    const missingDir = run('codex-patch-workspace.mjs', '--write-patch');
    expect(missingDir.status).toBe(1);
    expect(missingDir.stderr).toContain('--write-patch requires a directory');

    const unprepared = run(
      'codex-patch-workspace.mjs',
      '--write-patch',
      fs.mkdtempSync(path.join(os.tmpdir(), 'frink-plain-')),
    );
    expect(unprepared.status).toBe(1);
    expect(unprepared.stderr).toContain('is not a Codex workspace prepared by --prepare-source');
  });

  it('keeps the build script to build arguments', () => {
    const result = run('build-codex-frink.mjs', '--prepare-source', '/tmp/codex');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown Codex build argument: --prepare-source');
  });

  it('still rejects an unknown build argument', () => {
    const result = run('build-codex-frink.mjs', '--all');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown Codex build argument: --all');
  });
});

describe('codexVersionStamp', () => {
  it('carries the patch identity so a stale bundled binary is detectable at runtime', () => {
    expect(codexVersionStamp(manifest)).toBe(
      `rust-v0.155.1+frink.${pinnedManifest.patchSha256.slice(0, 12)}`,
    );
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

  it('finds the initialize reply among the notifications and server requests sharing stdout', () => {
    const transcript = [
      JSON.stringify({ method: 'configWarning', params: {} }),
      '',
      // The server numbers its own requests from 1 too; only a message without `method` is a reply.
      JSON.stringify({ id: 1, method: 'item/tool/requestUserInput', params: {} }),
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

  const reply = JSON.stringify(JSON.stringify({ id: 1, result: good }));
  // Like `codex app-server`, this fake exits on stdin EOF, so it can only answer while stdin is open.
  const slowAppServer = `process.stdin.on('end', () => process.exit(0));
    process.stdin.once('data', () => {
      console.log('{"method":"configWarning"}');
      console.log('{"id":1,"method":"item/tool/requestUserInput"}');
      setTimeout(() => console.log(${reply}), 200);
    });`;

  it('keeps stdin open past notifications and server requests until the delayed reply', async () => {
    const stdout = await runInitializeHandshake(
      process.execPath,
      ['-e', slowAppServer],
      '{"id":1}',
    );
    expect(parseInitializeResult(stdout)).toEqual(good);
  });

  it('gives a reply that lands near the deadline its own window to exit', async () => {
    // Answers at half the timeout, then takes 0.6 of it to exit: past a single shared deadline.
    const lateAppServer = `process.stdin.on('end', () => setTimeout(() => process.exit(0), 1200));
      process.stdin.once('data', () => setTimeout(() => console.log(${reply}), 1000));`;
    const stdout = await runInitializeHandshake(
      process.execPath,
      ['-e', lateAppServer],
      '{"id":1}',
      { timeoutMs: 2000 },
    );
    expect(parseInitializeResult(stdout)).toEqual(good);
  });

  it('fails a timeout only once the app-server is dead, even one that ignores SIGTERM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-handshake-'));
    const pidFile = path.join(dir, 'pid');
    const hung = [
      '-e',
      "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
      pidFile,
    ];
    try {
      await expect(
        runInitializeHandshake(process.execPath, hung, '{"id":1}', { timeoutMs: 2000 }),
      ).rejects.toThrow('did not answer initialize within 2000ms');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow('ESRCH');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces the stderr of an app-server that exits without answering', async () => {
    const crash = ['-e', "console.error('config load failed'); process.exitCode = 3"];
    await expect(runInitializeHandshake(process.execPath, crash, '{"id":1}')).rejects.toThrow(
      'exited (3) before answering initialize: config load failed',
    );
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
