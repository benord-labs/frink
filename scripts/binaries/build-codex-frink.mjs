#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { downloadToFile, sha256File } from './http-download.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const ROOT_DIR = path.dirname(path.dirname(path.dirname(SCRIPT_PATH)));
export const MANIFEST_PATH = path.join(ROOT_DIR, 'patches', 'codex', 'manifest.json');
const LINE_BREAK_PATTERN = /\r?\n/;
const WHITESPACE_PATTERN = /\s+/;
const EXPECTED_MANIFEST = Object.freeze({
  upstream: 'https://github.com/openai/codex',
  version: 'rust-v0.155.1',
  tagObject: '4e21628f9ec9ee656650cd2b62ef92225725b5ac',
  commit: 'be2951ea34f0d295ed0becf97079f92fa5f6950e',
  sourceArchiveSha256: 'b9e18d40d322586913e94d6747f3f934922c4f5130eb5a349ba019c57b83dad8',
  normalizedCargoLockSha256: 'df88a71b82843c6f092610fb07589f7a40032ddc25f50718354546ca541eb9b7',
  rust: '1.95.0',
  patch: 'frink-host-tool-permission-v1.patch',
});
/** The patch identity is pinned once, in the manifest; the build checks the patch file against it. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const TARGETS = {
  'darwin-arm64': { binary: 'codex', cargoTarget: 'aarch64-apple-darwin' },
  'darwin-x64': { binary: 'codex', cargoTarget: 'x86_64-apple-darwin' },
  'linux-x64': { binary: 'codex', cargoTarget: 'x86_64-unknown-linux-gnu' },
  'linux-arm64': { binary: 'codex', cargoTarget: 'aarch64-unknown-linux-gnu' },
  'win32-x64': { binary: 'codex.exe', cargoTarget: 'x86_64-pc-windows-msvc' },
};

const PROVIDER_TEST_FILTERS = [
  'frink_',
  'cancelled_turn_never_polls_mcp_transport',
  'every_mcp_request_meta_includes_exact_frink_dedup_identity',
  'decline_before_run_emits_command_lifecycle',
  'write_stdin_defer_fails_closed_without_a_native_reviewer',
  'write_stdin_permission_target_rejects_reused_process_id',
];

export const RUST_TAG_PREFIX = /^rust-v/;
const THREAD_ITEMS_PATH = path.join(ROOT_DIR, 'patches', 'codex', 'thread-item-variants.json');
const THREAD_ITEM_SCHEMA_PATH = [
  'codex-rs',
  'app-server-protocol',
  'schema',
  'typescript',
  'v2',
  'ThreadItem.ts',
];
const THREAD_ITEM_TAG_PATTERN = /\{\s*"type":\s*"([A-Za-z][A-Za-z0-9]*)"/g;
/** Mirrors FRINK_HOST_TOOL_PERMISSION_VERSION (src/main/lib/agent-runner/codex/codex-host-permissions.ts). */
const FRINK_HOST_PERMISSION_VERSION = 1;
const HANDSHAKE_CLIENT_NAME = 'frink-build-check';
/** Fixed, never the pin: no manifest value may enter the request the version assertion reads back. */
const HANDSHAKE_CLIENT_VERSION = '0';
const HANDSHAKE_TIMEOUT_MS = 60_000;
const MCP_REPLACE_SENTINEL = '__frink_replace';

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function releaseTargetKeys(platform = process.platform, arch = process.arch) {
  return platform === 'darwin' ? ['darwin-arm64', 'darwin-x64'] : [platformKey(platform, arch)];
}

export function parseBuildArguments(args) {
  const targetKeys = [];
  let runProviderTests = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--test') {
      runProviderTests = true;
      continue;
    }
    if (argument === '--target') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--target requires a platform key');
      targetKeys.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown Codex build argument: ${argument}`);
  }
  return { targetKeys, runProviderTests };
}

export function normalizeWorkspaceVersions(lockfile, version) {
  return lockfile.replace(/^version = "0\.0\.0"$/gm, `version = "${version}"`);
}

/**
 * Stamp written next to the bundled binary. Carries the patch identity so the runtime can tell a
 * binary built from an older patch apart from the one the current app expects.
 */
export function codexVersionStamp(manifest) {
  return `${manifest.version}+frink.${manifest.patchSha256.slice(0, 12)}`;
}

export function validateManifest(manifest) {
  for (const [field, expected] of Object.entries(EXPECTED_MANIFEST)) {
    if (manifest[field] !== expected) {
      throw new Error(`Invalid pinned Codex source manifest field: ${field}`);
    }
  }
  if (!SHA256_PATTERN.test(manifest.patchSha256)) {
    throw new Error('Invalid pinned Codex source manifest field: patchSha256');
  }
  return manifest;
}

export function validateRemoteTagOutput(manifest, output) {
  const refs = new Map(
    output
      .trim()
      .split(LINE_BREAK_PATTERN)
      .filter(Boolean)
      .map((line) => line.split(WHITESPACE_PATTERN, 2).reverse()),
  );
  const tagRef = `refs/tags/${manifest.version}`;
  if (refs.get(tagRef) !== manifest.tagObject || refs.get(`${tagRef}^{}`) !== manifest.commit) {
    throw new Error('Pinned Codex tag identity does not match upstream');
  }
}

export function readManifest() {
  return validateManifest(JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')));
}

export function assertRustVersion(rustc, expected) {
  const actual = execFileSync(rustc, ['--version'], { encoding: 'utf8' }).trim();
  if (!actual.startsWith(`rustc ${expected} `)) {
    throw new Error(`Codex requires rustc ${expected}; found ${actual}`);
  }
}

export function cargoExecutable() {
  return process.env.CARGO || 'cargo';
}

export function rustcExecutable() {
  return process.env.RUSTC || 'rustc';
}

/**
 * Persistent by default so a rebuild after a patch change is incremental (minutes) instead of a
 * cold compile of the whole workspace (hours on a memory-constrained laptop). CI sets its own.
 */
function cargoTargetDir() {
  return process.env.CARGO_TARGET_DIR || path.join(os.homedir(), '.cache', 'frink-codex-target');
}

/**
 * Upstream's release profile keeps DWARF (strip = false, split-debuginfo = off) for packaging to
 * strip. macOS and MSVC keep it outside the executable, but ELF links it in: ~1 GB of a 1.3 GB
 * Linux codex (sc-4794). `debuginfo` keeps the symbol table so panic backtraces still name frames.
 */
export function releaseProfileEnv(cargoTarget) {
  return cargoTarget.includes('-linux-') ? { CARGO_PROFILE_RELEASE_STRIP: 'debuginfo' } : {};
}

function rustupExecutable() {
  if (process.env.RUSTUP) return process.env.RUSTUP;
  const executable = process.platform === 'win32' ? 'rustup.exe' : 'rustup';
  const userInstall = path.join(os.homedir(), '.cargo', 'bin', executable);
  return fs.existsSync(userInstall) ? userInstall : executable;
}

function installRustTarget(cargoTarget, version) {
  execFileSync(rustupExecutable(), ['target', 'add', cargoTarget, '--toolchain', version], {
    stdio: 'inherit',
  });
}

export function runProviderRegressionTests(cargo, rustc, cargoRoot) {
  for (const filter of PROVIDER_TEST_FILTERS) {
    execFileSync(
      cargo,
      [
        'test',
        '--locked',
        '--package',
        'codex-app-server-protocol',
        '--package',
        'codex-app-server',
        '--package',
        'codex-core',
        '--package',
        'codex-hooks',
        '--package',
        'codex-config',
        filter,
      ],
      {
        cwd: cargoRoot,
        env: { ...process.env, RUSTC: rustc, CARGO_TARGET_DIR: cargoTargetDir() },
        stdio: 'inherit',
      },
    );
  }
}

/** Variant tags of upstream's generated ThreadItem union, deduped and sorted. */
export function parseThreadItemVariants(schemaSource) {
  return [...new Set([...schemaSource.matchAll(THREAD_ITEM_TAG_PATTERN)].map((m) => m[1]))].sort();
}

/**
 * A ThreadItem variant Frink never classified renders as an empty `codex_<type>` card, so a bump
 * that grows the union must update the fixture and codex-events.ts before it can produce a binary.
 */
export function assertPinnedThreadItems(manifest, declared, upstream) {
  if (declared.version !== manifest.version) {
    throw new Error(
      `thread-item-variants.json pins ${declared.version}, manifest pins ${manifest.version}`,
    );
  }
  const added = upstream.filter((type) => !declared.variants.includes(type));
  const removed = declared.variants.filter((type) => !upstream.includes(type));
  if (added.length === 0 && removed.length === 0) return;
  throw new Error(
    `Codex ThreadItem union drifted (added: ${added.join(', ') || 'none'}; removed: ${
      removed.join(', ') || 'none'
    }). Classify each in codex-events.ts, then update patches/codex/thread-item-variants.json.`,
  );
}

/** A response to request 1. The server numbers its own requests too, and those carry `method`. */
function isInitializeReply(message) {
  return message?.id === 1 && message.method === undefined;
}

/** The `initialize` reply from an app-server stdout transcript, which also carries notifications. */
export function parseInitializeResult(stdout) {
  for (const line of stdout.split(LINE_BREAK_PATTERN)) {
    if (line.trim().length === 0) continue;
    const message = JSON.parse(line);
    if (isInitializeReply(message)) return message.result ?? null;
  }
  return null;
}

/**
 * The stamp beside the binary is written by this script, so it cannot witness the binary itself.
 * `userAgent` can: codex builds it as `<client name>/<ITS OWN version> (os) (<client name>; <client
 * version>)`, so the leading segment is binary-owned and the echoed client half is never read.
 */
export function assertHandshakeResult(manifest, result) {
  if (result?.capabilities?.frinkHostToolPermission !== FRINK_HOST_PERMISSION_VERSION) {
    throw new Error(
      `Built Codex does not advertise frinkHostToolPermission v${FRINK_HOST_PERMISSION_VERSION}: ${JSON.stringify(result?.capabilities ?? null)}`,
    );
  }
  const expected = `${HANDSHAKE_CLIENT_NAME}/${manifest.version.replace(RUST_TAG_PREFIX, '')} `;
  if (!String(result.userAgent ?? '').startsWith(expected)) {
    throw new Error(
      `Built Codex reports "${result.userAgent}", expected it to start "${expected}"`,
    );
  }
}

function isInitializeReplyLine(line) {
  try {
    return isInitializeReply(JSON.parse(line));
  } catch {
    return false;
  }
}

/**
 * Writes `request` to the app-server and resolves its stdout once it has answered id 1 and exited.
 * Stdin closes only after that reply: on EOF the app-server can exit without answering.
 */
export function runInitializeHandshake(
  command,
  args,
  request,
  { env, timeoutMs = HANDSHAKE_TIMEOUT_MS } = {},
) {
  return new Promise((resolve, reject) => {
    // Piped so the app-server's untrusted-project warning stays out of the build log; a failed
    // handshake still surfaces its stderr below.
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let answered = false;
    let timedOut = false;
    const kill = () => {
      timedOut = true;
      // SIGKILL: a server that ignores SIGTERM would otherwise outlive the failed check.
      child.kill('SIGKILL');
    };
    let timer = setTimeout(kill, timeoutMs);
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      stdout += `${line}\n`;
      if (!answered && isInitializeReplyLine(line)) {
        answered = true;
        // A late reply gets its own window to exit, so it is never misreported as no answer.
        clearTimeout(timer);
        timer = setTimeout(kill, timeoutMs);
        child.stdin.end();
      }
    });
    // An early exit breaks the pipe; 'close' reports that failure with the stderr.
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // A timeout also settles here, once the child is gone, so callers never clean up under it.
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (answered && code === 0) return resolve(stdout);
      if (timedOut) {
        const step = answered ? 'exit after answering' : 'answer';
        return reject(
          new Error(`Codex app-server did not ${step} initialize within ${timeoutMs}ms`),
        );
      }
      const when = answered ? '' : ' before answering initialize';
      reject(new Error(`Codex app-server exited (${code ?? signal})${when}: ${stderr.trim()}`));
    });
    child.stdin.write(`${request}\n`);
  });
}

/** Drives one real `initialize` round trip against the binary this script just built. */
async function verifyBundledHandshake(manifest, binaryPath, tempRoot) {
  const codexHome = fs.mkdtempSync(path.join(tempRoot, 'handshake-'));
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: HANDSHAKE_CLIENT_NAME, version: HANDSHAKE_CLIENT_VERSION },
      capabilities: {
        experimentalApi: true,
        frinkHostToolPermission: FRINK_HOST_PERMISSION_VERSION,
      },
    },
  });
  const stdout = await runInitializeHandshake(binaryPath, ['app-server'], request, {
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  assertHandshakeResult(manifest, parseInitializeResult(stdout));
}

/** Rejects a config load that kept Frink's MCP replace sentinel instead of consuming it. */
export function assertMcpReplaceConsumed(output) {
  if (output.includes(MCP_REPLACE_SENTINEL) || output.includes('failed to load configuration')) {
    throw new Error(`Built Codex did not consume ${MCP_REPLACE_SENTINEL}: ${output.trim()}`);
  }
}

/**
 * Frink sends the replace sentinel on every thread; with no user `[mcp_servers]` table the patch
 * must still strip it, or every turn fails config load (sc-3824). `mcp list` loads the same layer
 * stack as thread/start, with `-c` as the session layer.
 */
function verifyEmptyHomeMcpReplace(binaryPath, tempRoot) {
  const codexHome = fs.mkdtempSync(path.join(tempRoot, 'mcp-replace-'));
  const stdout = execFileSync(
    binaryPath,
    ['-c', `mcp_servers={${MCP_REPLACE_SENTINEL}=true}`, 'mcp', 'list'],
    {
      encoding: 'utf8',
      timeout: HANDSHAKE_TIMEOUT_MS,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  assertMcpReplaceConsumed(stdout);
}

function validateTargetKeys(targetKeys) {
  const uniqueTargetKeys = [...new Set(targetKeys)];
  if (uniqueTargetKeys.length === 0) throw new Error('At least one Codex build target is required');
  for (const key of uniqueTargetKeys) {
    if (!TARGETS[key]) throw new Error(`Unsupported Codex build platform: ${key}`);
  }
  return uniqueTargetKeys;
}

/** Download the pinned upstream archive into `destRoot`, verify it, and return the extracted tree. */
export async function fetchCodexSource(destRoot, manifest) {
  validateRemoteTagOutput(
    manifest,
    execFileSync(
      'git',
      [
        'ls-remote',
        manifest.upstream,
        `refs/tags/${manifest.version}`,
        `refs/tags/${manifest.version}^{}`,
      ],
      { encoding: 'utf8' },
    ),
  );
  const archive = path.join(destRoot, 'codex.tar.gz');
  const sourceUrl = `https://github.com/openai/codex/archive/refs/tags/${manifest.version}.tar.gz`;
  await downloadToFile(sourceUrl, archive);
  const actualSha = sha256File(archive);
  if (actualSha !== manifest.sourceArchiveSha256) {
    throw new Error(
      `Codex source SHA-256 mismatch: expected ${manifest.sourceArchiveSha256}, got ${actualSha}`,
    );
  }

  execFileSync('tar', ['-xzf', archive, '-C', destRoot], { stdio: 'inherit' });
  return path.join(destRoot, `codex-${manifest.version}`);
}

/** Rewrite the lockfile's placeholder workspace versions in place, as a `--locked` build needs. */
export function normalizeCargoLock(sourceDir, manifest) {
  const lockPath = path.join(sourceDir, 'codex-rs', 'Cargo.lock');
  const normalizedLock = normalizeWorkspaceVersions(
    fs.readFileSync(lockPath, 'utf8'),
    manifest.version.replace(RUST_TAG_PREFIX, ''),
  );
  fs.writeFileSync(lockPath, normalizedLock);
  const actualLockSha = sha256File(lockPath);
  if (actualLockSha !== manifest.normalizedCargoLockSha256) {
    throw new Error(
      `Normalized Cargo.lock SHA-256 mismatch: expected ${manifest.normalizedCargoLockSha256}, got ${actualLockSha}`,
    );
  }
}

async function prepareCodexSource(tempRoot, manifest) {
  const sourceDir = await fetchCodexSource(tempRoot, manifest);
  const patchPath = path.join(ROOT_DIR, 'patches', 'codex', manifest.patch);
  const actualPatchSha = sha256File(patchPath);
  if (actualPatchSha !== manifest.patchSha256) {
    throw new Error(
      `Codex provider patch SHA-256 mismatch: expected ${manifest.patchSha256}, got ${actualPatchSha}`,
    );
  }
  execFileSync('git', ['apply', '--check', patchPath], { cwd: sourceDir, stdio: 'inherit' });
  execFileSync('git', ['apply', patchPath], { cwd: sourceDir, stdio: 'inherit' });
  normalizeCargoLock(sourceDir, manifest);
  return sourceDir;
}

export function buildCodexTarget({
  key,
  target,
  manifest,
  sourceDir,
  cargoRoot,
  cargo,
  rustc,
  outputRoot,
}) {
  installRustTarget(target.cargoTarget, manifest.rust);
  execFileSync(
    cargo,
    ['build', '--locked', '--release', '--package', 'codex-cli', '--target', target.cargoTarget],
    {
      cwd: cargoRoot,
      env: {
        ...process.env,
        RUSTC: rustc,
        CARGO_TARGET_DIR: cargoTargetDir(),
        ...releaseProfileEnv(target.cargoTarget),
      },
      stdio: 'inherit',
    },
  );

  const outputDir = path.join(outputRoot, key);
  fs.mkdirSync(outputDir, { recursive: true });
  const builtBinary = path.join(
    path.resolve(cargoRoot, cargoTargetDir()),
    target.cargoTarget,
    'release',
    target.binary,
  );
  const outputBinary = path.join(outputDir, target.binary);
  fs.copyFileSync(builtBinary, outputBinary);
  if (process.platform !== 'win32') fs.chmodSync(outputBinary, 0o755);
  fs.copyFileSync(path.join(sourceDir, 'LICENSE'), path.join(outputDir, 'codex-LICENSE.txt'));
  fs.copyFileSync(path.join(sourceDir, 'NOTICE'), path.join(outputDir, 'codex-NOTICE.txt'));
  fs.writeFileSync(path.join(outputDir, 'CODEX_VERSION'), `${codexVersionStamp(manifest)}\n`);
  return outputBinary;
}

export async function buildCodexFrink({
  outputRoot = path.join(ROOT_DIR, 'resources', 'bin'),
  targetKeys = [platformKey()],
  runProviderTests = false,
} = {}) {
  const manifest = readManifest();
  const uniqueTargetKeys = validateTargetKeys(targetKeys);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-codex-build-'));
  try {
    const sourceDir = await prepareCodexSource(tempRoot, manifest);
    assertPinnedThreadItems(
      manifest,
      JSON.parse(fs.readFileSync(THREAD_ITEMS_PATH, 'utf8')),
      parseThreadItemVariants(
        fs.readFileSync(path.join(sourceDir, ...THREAD_ITEM_SCHEMA_PATH), 'utf8'),
      ),
    );
    const cargo = cargoExecutable();
    const rustc = rustcExecutable();
    const cargoRoot = path.join(sourceDir, 'codex-rs');
    assertRustVersion(rustc, manifest.rust);
    if (runProviderTests) runProviderRegressionTests(cargo, rustc, cargoRoot);

    const binaries = [];
    for (const key of uniqueTargetKeys) {
      const binaryPath = buildCodexTarget({
        key,
        target: TARGETS[key],
        manifest,
        sourceDir,
        cargoRoot,
        cargo,
        rustc,
        outputRoot,
      });
      // A cross-compiled target cannot run here; its own CI leg handshakes the build it produces.
      if (key === platformKey()) {
        await verifyBundledHandshake(manifest, binaryPath, tempRoot);
        verifyEmptyHomeMcpReplace(binaryPath, tempRoot);
      }
      binaries.push(binaryPath);
    }
    return binaries;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main(args) {
  const { targetKeys, runProviderTests } = parseBuildArguments(args);
  const binaries = await buildCodexFrink({
    targetKeys: targetKeys.length > 0 ? targetKeys : [platformKey()],
    runProviderTests,
  });
  return `Built permission-aware Codex: ${binaries.join(', ')}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2))
    .then((message) => console.log(message))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
