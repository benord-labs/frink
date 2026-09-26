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
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

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

/** Load the resolved native modules under the Electron ABI and exercise each. Throws on any failure. */
async function main() {
  const root = resolveModulesRoot();
  console.log(`[smoke-native] ABI (NODE_MODULE_VERSION) = ${process.versions.modules}`);
  console.log(`[smoke-native] modules root = ${root}`);
  checkNodeSqlite();
  console.log('[smoke-native] node:sqlite OK');
  await checkNodePty(root);
  console.log('[smoke-native] node-pty OK');
  console.log('[smoke-native] PASS');
}

// Only run when invoked as the entry; importing the module (tests) just exposes the pure resolver.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[smoke-native] FAIL');
      console.error(err);
      process.exit(1);
    });
}

module.exports = { resolveModulesRoot };
