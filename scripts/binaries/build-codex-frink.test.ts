import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import threadItems from '../../patches/codex/thread-item-variants.json';
import { FRINK_HOST_TOOL_PERMISSION_VERSION } from '../../src/main/lib/agent-runner/codex/codex-host-permissions';
import {
  assertHandshakeResult,
  assertMcpReplaceConsumed,
  assertPinnedThreadItems,
  codexVersionStamp,
  describeTranscript,
  initializeResultFromMessage,
  normalizeWorkspaceVersions,
  parseBuildArguments,
  parseThreadItemVariants,
  platformKey,
  releaseTargetKeys,
  runInitializeHandshake,
  validateManifest,
  validateRemoteTagOutput,
  verifyBundledHandshake,
} from './build-codex-frink.mjs';

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

  it('puts what the binary printed into a failed capability check', () => {
    expect(() =>
      assertHandshakeResult(manifest, null, { stdout: '{"method":"x"}\n', stderr: 'boom\n' }),
    ).toThrow(/does not advertise[\s\S]*\{"method":"x"\}[\s\S]*boom/);
  });

  it('reports an initialize error reply as such, with the error the binary sent', () => {
    const transcript = { stdout: '', stderr: 'why\n' };
    expect(() =>
      initializeResultFromMessage(
        { id: 1, error: { code: -32600, message: 'bad request' } },
        transcript,
      ),
    ).toThrow(/rejected initialize: \{"code":-32600,"message":"bad request"\}[\s\S]*why/);
    expect(initializeResultFromMessage({ id: 1, result: good }, transcript)).toEqual(good);
    expect(initializeResultFromMessage({ id: 1 }, transcript)).toBeNull();
  });

  describe('against a live app-server process', () => {
    const request = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`;
    const reply = JSON.stringify({ id: 1, result: good });
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-handshake-test-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function handshake(source: string, timeoutMs = 10_000) {
      const script = path.join(dir, 'app-server.mjs');
      fs.writeFileSync(script, source);
      return runInitializeHandshake(process.execPath, [script], {
        input: request,
        env: process.env,
        timeoutMs,
      });
    }

    it('keeps stdin open until a slow reply arrives from a server that exits on stdin EOF', async () => {
      // The sc-4465 race: closing stdin with the request ended the server before it answered.
      const { message } = await handshake(`
        process.stdin.on('data', () => setTimeout(() => process.stdout.write(${JSON.stringify(reply)} + '\\n'), 200));
        process.stdin.on('end', () => process.exit(0));
      `);
      expect(message).toEqual({ id: 1, result: good });
    });

    it('finds the reply among notifications, blank lines and non-JSON output', async () => {
      const { message } = await handshake(`
        process.stdin.once('data', () => {
          process.stdout.write('{"method":"configWarning","params":{}}\\n\\nnot json\\n');
          process.stdout.write(${JSON.stringify(reply)} + '\\n');
        });
      `);
      expect(message).toEqual({ id: 1, result: good });
    });

    it('reads a reply split across two writes', async () => {
      const { message } = await handshake(`
        const reply = ${JSON.stringify(reply)};
        process.stdin.once('data', () => {
          process.stdout.write(reply.slice(0, 20));
          setTimeout(() => process.stdout.write(reply.slice(20) + '\\n'), 50);
        });
      `);
      expect(message).toEqual({ id: 1, result: good });
    });

    it('shows the exit code and both streams when the server exits without replying', async () => {
      await expect(
        handshake(`
          process.stdout.write('{"method":"startup"}\\n');
          process.stderr.write('config load failed\\n');
          process.exit(3);
        `),
      ).rejects.toThrow(
        /exited \(code 3\) before answering initialize[\s\S]*\{"method":"startup"\}[\s\S]*config load failed/,
      );
    });

    it('times out a server that never replies, kills it, and shows its stderr', async () => {
      const error = await handshake(
        `
          process.stderr.write('pid:' + process.pid + '\\n');
          process.stdin.resume();
          setInterval(() => {}, 1000);
        `,
        500,
      ).catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/did not answer initialize within 500ms[\s\S]*pid:\d+/);
      await expect.poll(() => isAlive(pidIn(error.message))).toBe(false);
    });

    it('reads a final reply that has no trailing newline before the server exits', async () => {
      // Only the `close` flush of the unterminated line can find this reply.
      const { message } = await handshake(`
        process.stdin.once('data', () => process.stdout.write(${JSON.stringify(reply)}, () => process.exit(0)));
      `);
      expect(message).toEqual({ id: 1, result: good });
    });

    it('accepts the reply even when the server then exits non-zero', async () => {
      // Once answered, the app-server's own shutdown status is not the check's concern.
      const { message } = await handshake(`
        process.stdin.once('data', () => process.stdout.write(${JSON.stringify(reply)} + '\\n', () => process.exit(1)));
      `);
      expect(message).toEqual({ id: 1, result: good });
    });

    it('returns on the reply and kills a server that ignores stdin EOF, so the build cannot hang', async () => {
      const { message } = await handshake(`
        process.stdin.once('data', () =>
          process.stdout.write(JSON.stringify({ id: 1, result: { pid: process.pid } }) + '\\n'));
        process.stdin.on('end', () => {});
        setInterval(() => {}, 1000);
      `);
      const { pid } = message.result;
      // Still alive at return: the reply resolved the check, not the server's eventual death.
      expect(isAlive(pid)).toBe(true);
      await expect.poll(() => isAlive(pid), { timeout: 5_000 }).toBe(false);
    });

    it('names a binary that cannot be started instead of throwing a bare spawn error', async () => {
      await expect(
        runInitializeHandshake(path.join(dir, 'missing-codex'), ['app-server'], {
          input: request,
          env: process.env,
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(/Could not run built Codex app-server: .*ENOENT/);
    });
  });

  describe('verifyBundledHandshake against a built binary', () => {
    let tempRoot: string;

    beforeEach(() => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-verify-test-'));
    });
    afterEach(() => {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    /** The `initialize` reply the fake binary sends back. */
    type InitializeAnswer = { id: 1; result: unknown } | { id: 1; error: unknown };

    /** An executable stand-in for the built binary, answering `initialize` with `answer`. */
    function fakeCodex(answer: InitializeAnswer) {
      const binary = path.join(tempRoot, 'codex');
      fs.writeFileSync(
        binary,
        `#!${process.execPath}
        if (process.argv[2] !== 'app-server' || !process.env.CODEX_HOME?.startsWith(${JSON.stringify(tempRoot)})) {
          process.stderr.write('wrong invocation: ' + process.argv.slice(2).join(' ') + ' ' + process.env.CODEX_HOME);
          process.exit(2);
        }
        process.stdin.once('data', () => process.stdout.write(${JSON.stringify(JSON.stringify(answer))} + '\\n'));
        process.stdin.on('end', () => process.exit(0));
        `,
      );
      fs.chmodSync(binary, 0o755);
      return binary;
    }

    it('passes a binary that answers app-server initialize with the capability and pinned version', async () => {
      await expect(
        verifyBundledHandshake(manifest, fakeCodex({ id: 1, result: good }), tempRoot),
      ).resolves.toBeUndefined();
    });

    it('fails an initialize error reply with the error, not as a missing capability', async () => {
      await expect(
        verifyBundledHandshake(
          manifest,
          fakeCodex({ id: 1, error: { code: -32603, message: 'boom' } }),
          tempRoot,
        ),
      ).rejects.toThrow(/rejected initialize: .*boom/);
    });

    it('fails an unpatched binary with what it actually returned', async () => {
      await expect(
        verifyBundledHandshake(
          manifest,
          fakeCodex({ id: 1, result: { ...good, capabilities: {} } }),
          tempRoot,
        ),
      ).rejects.toThrow(
        /does not advertise frinkHostToolPermission v1: \{\}[\s\S]*app-server stdout[\s\S]*"capabilities":\{\}/,
      );
    });
  });
});

describe('handshake transcript evidence', () => {
  it('keeps a transcript up to the tail limit whole and marks the cut beyond it', () => {
    const exact = 'a'.repeat(4_000);
    expect(describeTranscript({ stdout: exact, stderr: '' })).toContain(
      `stdout ---\n${exact}\n--- app-server stderr ---\n(empty)`,
    );
    const long = `HEAD${'b'.repeat(4_000)}`;
    const described = describeTranscript({ stdout: long, stderr: '' });
    expect(described).not.toContain('HEAD');
    expect(described).toContain(`…${'b'.repeat(4_000)}`);
  });
});

function pidIn(text: string) {
  return Number(text.match(/pid:(\d+)/)?.[1]);
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
