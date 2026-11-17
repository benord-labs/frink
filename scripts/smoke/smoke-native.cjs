/**
 * Electron-ABI smoke: prove the SHIPPED native modules (node-pty; sqlite is Node's
 * built-in `node:sqlite`, ABI-free by construction) load and run under Electron's ABI.
 *
 * Run via Electron's bundled Node — `ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-native.cjs`.
 * That uses the same V8/NODE_MODULE_VERSION the real app runs on, so a module built for the
 * wrong ABI throws NODE_MODULE_VERSION here — but it skips all GUI/Chromium init, which
 * otherwise hangs forever on a headless Windows CI runner (no interactive desktop, and
 * Windows has no xvfb). A plain `electron <script>` (GUI mode) is NOT usable in CI for this
 * reason.
 *
 * It loads from the PACKAGED copy by default (the one `package:win` emits under
 * app.asar.unpacked) rather than dev node_modules — testing dev node_modules would
 * false-green a packaging break. Override with FRINK_SMOKE_MODULES_ROOT (e.g. on macOS:
 *   FRINK_SMOKE_MODULES_ROOT=node_modules ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke-native.cjs).
 */
const { spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const PACKAGED = resolve('release/win-unpacked/resources/app.asar.unpacked/node_modules');

/**
 * Pick the node_modules root to smoke-test, in priority order:
 *   1. FRINK_SMOKE_MODULES_ROOT — explicit override (an empty value is ignored).
 *   2. the PACKAGED app.asar.unpacked copy when a `package:win` build exists.
 *   3. dev node_modules — local fallback.
 * Always returns an absolute path. Picking the wrong root would false-green a
 * packaging break, so this is the load-bearing branch worth pinning in a test.
 */
function resolveModulesRoot(env = process.env, packagedExists = existsSync(PACKAGED)) {
  if (env.FRINK_SMOKE_MODULES_ROOT) return resolve(env.FRINK_SMOKE_MODULES_ROOT);
  return packagedExists ? PACKAGED : resolve('node_modules');
}

/** Sanity-check the built-in sqlite the app now relies on (no packaged binary involved). */
function checkNodeSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const { ok } = db.prepare('select 1 as ok').get();
  db.close();
  if (ok !== 1) throw new Error(`node:sqlite returned ${ok}, expected 1`);
}

/** The shell + args that echo the marker, per OS (cmd.exe on Windows, /bin/sh elsewhere). */
function ptyCommand() {
  if (process.platform === 'win32') {
    return { shell: process.env.ComSpec || 'cmd.exe', args: ['/c', 'echo frink-pty-ok'] };
  }
  return { shell: '/bin/sh', args: ['-c', 'echo frink-pty-ok'] };
}

/** Load node-pty from `root`, spawn a real pty, and resolve once the round-trip marker arrives. */
function checkNodePty(root) {
  const pty = require(join(root, 'node-pty'));
  const { shell, args } = ptyCommand();
  const child = pty.spawn(shell, args, { cols: 80, rows: 24 });
  return new Promise((res, rej) => {
    let out = '';
    const timer = setTimeout(() => rej(new Error('node-pty timed out after 15s')), 15_000);
    child.onData((d) => {
      out += d;
    });
    child.onExit(() => {
      clearTimeout(timer);
      if (out.includes('frink-pty-ok')) res();
      else rej(new Error(`node-pty output missing marker: ${JSON.stringify(out)}`));
    });
  });
}

/** The agent libraries are plain JavaScript, so a package build keeps them inside app.asar. */
function packedModulesRoot(root) {
  return root.replace('app.asar.unpacked', 'app.asar');
}

/** The packaged file a dynamic import of `name` loads: its `import` export, never the CommonJS one. */
function packedEntry(root, name) {
  const dir = join(packedModulesRoot(realpathSync(root)), name);
  const target = require(join(dir, 'package.json')).exports['.'].import;
  // The export is a path, or conditions whose `default` is the path.
  return join(dir, target.default ?? target);
}

/** Import a packaged agent library the way the main process does: a dynamic import. */
async function importPacked(root, name) {
  const entry = packedEntry(root, name);
  console.log(`[smoke-native] ${name} from ${entry}`);
  return import(pathToFileURL(entry).href);
}

async function checkAgentSdks(root) {
  const { PROTOCOL_VERSION } = await importPacked(root, '@agentclientprotocol/sdk');
  if (!Number.isInteger(PROTOCOL_VERSION)) throw new Error('ACP SDK has no PROTOCOL_VERSION');
  console.log(`[smoke-native] ACP SDK OK (protocol ${PROTOCOL_VERSION})`);
  // Its platform runtime and FFI module are left out of the build; the client must load without them.
  const { CopilotClient } = await importPacked(root, '@github/copilot-sdk');
  if (!CopilotClient) throw new Error('GitHub Copilot SDK has no CopilotClient');
  console.log('[smoke-native] GitHub Copilot SDK OK');
}

const CURSOR_HOST = '--cursor-host';

/** In Electron's main process: start the packaged Cursor host as a utility process, print its first message. */
async function printCursorHostAnswer(resources) {
  const { app, utilityProcess } = require('electron');
  await app.whenReady();
  const sdkEntry = packedEntry(join(resources, 'app.asar.unpacked', 'node_modules'), '@cursor/sdk');
  const host = utilityProcess.fork(join(resources, 'cursor', 'cursor-host.mjs'), [sdkEntry], {
    env: { HOME: process.env.HOME, PATH: process.env.PATH },
    cwd: process.env.HOME,
  });
  const answer = await new Promise((res) => {
    setTimeout(() => res({ type: 'error', text: 'no answer in 60s' }), 60_000).unref();
    host.once('message', res);
    host.once('exit', (code) => res({ type: 'error', text: `the host exited with ${code}` }));
  });
  host.kill();
  console.log(JSON.stringify(answer));
}

/** Start this script again as Electron's main process, under a temp HOME, for the host's answer. */
function cursorHostAnswer(resources) {
  const home = mkdtempSync(join(tmpdir(), 'frink-smoke-cursor-'));
  const env = { ...process.env, HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CURSOR_API_KEY;
  // A dev Electron's chrome-sandbox is not setuid; the Linux launch smoke proves the packaged sandbox.
  const flags = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const child = spawnSync(process.execPath, [...flags, __filename, CURSOR_HOST, resources], {
    env,
    encoding: 'utf8',
    timeout: 90_000,
  });
  rmSync(home, { recursive: true, force: true });
  return { answer: JSON.parse(child.stdout.trim().split('\n').at(-1) || '{}'), log: child.stderr };
}

/** The packaged Cursor platform package beside `root`, or null where none ships (Windows, dev trees). */
function cursorPlatformDir(root, platform = process.platform, arch = process.arch) {
  if (platform === 'win32' || !root.endsWith(join('app.asar.unpacked', 'node_modules')))
    return null;
  return join(dirname(dirname(root)), 'node_modules', '@cursor', `sdk-${platform}-${arch}`);
}

/** rg is present and both shell parsers load: without them the SDK quietly stops analysing commands. */
function checkCursorPlatform(dir) {
  if (!existsSync(join(dir, 'bin', 'rg'))) throw new Error(`no rg in ${dir}`);
  for (const parser of ['tree-sitter', 'tree-sitter-bash']) {
    process.dlopen({ exports: {} }, join(dir, 'vendor', parser, 'binding.node'));
  }
}

/** Cursor's platform package sits where its SDK looks, and the host answers signed out. */
function checkCursorHost(resources, platformDir) {
  checkCursorPlatform(platformDir);
  const { answer, log } = cursorHostAnswer(resources);
  if (answer.type !== 'auth' || answer.status === 'logged-in') {
    throw new Error(`Cursor host answered ${JSON.stringify(answer)}: ${log}`);
  }
  console.log(`[smoke-native] Cursor host OK (utility process, ${answer.status})`);
}

/** Load the resolved native modules under the Electron ABI and exercise each. Throws on any failure. */
async function main() {
  const root = resolveModulesRoot();
  console.log(`[smoke-native] ABI (NODE_MODULE_VERSION) = ${process.versions.modules}`);
  console.log(`[smoke-native] modules root = ${root}`);
  checkNodeSqlite();
  console.log('[smoke-native] node:sqlite OK');
  await checkNodePty(root);
  console.log('[smoke-native] node-pty OK');
  await checkAgentSdks(root);
  const cursor = cursorPlatformDir(root);
  if (cursor) checkCursorHost(dirname(dirname(root)), cursor);
  else console.log('[smoke-native] Cursor host skipped: it ships only in a macOS or Linux package');
  console.log('[smoke-native] PASS');
}

// Only run when invoked as the entry; importing the module (tests) just exposes the pure resolver.
// Electron's main process loads this file through its default app, so it is not require.main there.
const hostAt = process.argv.indexOf(CURSOR_HOST);
if (require.main === module || hostAt > 0) {
  const run = hostAt > 0 ? () => printCursorHostAnswer(process.argv[hostAt + 1]) : main;
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[smoke-native] FAIL');
      console.error(err);
      process.exit(1);
    });
}

module.exports = {
  checkCursorPlatform,
  cursorPlatformDir,
  packedEntry,
  packedModulesRoot,
  resolveModulesRoot,
};
