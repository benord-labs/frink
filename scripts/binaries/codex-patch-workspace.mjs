/**
 * Edit loop for the bundled Codex patch: `--prepare-source` lays the pinned upstream tree out as a
 * git repository with the Frink patch committed on top, `--write-patch` regenerates the patch file
 * from that repository in one canonical format, and `--test-only` runs the provider regression
 * tests against it. Run as `bun run codex:patch -- <mode> <dir>`; see patches/codex/README.md.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertRustVersion,
  cargoExecutable,
  fetchCodexSource,
  MANIFEST_PATH,
  normalizeCargoLock,
  normalizeWorkspaceVersions,
  ROOT_DIR,
  readManifest,
  runProviderRegressionTests,
  RUST_TAG_PREFIX,
  rustcExecutable,
} from './build-codex-frink.mjs';
import { sha256File } from './http-download.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const PRISTINE_TAG = 'frink-pristine';
export const PATCHED_TAG = 'frink-patched';
const CARGO_LOCK = 'codex-rs/Cargo.lock';
/** Inside the workspace's .git: the hash of the committed patch the workspace currently matches. */
const PATCH_BASE_FILE = 'frink-patch-base';
/** Beside the manifest: held for the whole read-check-write of one --write-patch. */
const WRITE_LOCK_FILE = '.write-patch.lock';
const MODES = { '--prepare-source': 'prepare', '--write-patch': 'write', '--test-only': 'test' };
const SECTION_PATTERN = /^diff --git a\/(.+) b\/\1$/gm;
const MAX_GIT_OUTPUT = 1024 * 1024 * 1024;

/** Nothing on the developer's machine may shape the output: the patch bytes are pinned by hash. */
const GIT_FIXED_CONFIG = [
  '-c',
  'user.name=Frink Codex patch',
  '-c',
  'user.email=codex-patch@frink.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'init.defaultBranch=main',
];

/** The one diff format the committed patch is written in. */
const CANONICAL_DIFF_ARGS = [
  'diff',
  '--binary',
  '--full-index',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '-U3',
  '--diff-algorithm=myers',
  PRISTINE_TAG,
  '--',
  '.',
  `:(exclude)${CARGO_LOCK}`,
];

function gitEnvironment(extra = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return {
    ...inherited,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

function git(dir, args, { env, encoding = 'utf8' } = {}) {
  return execFileSync('git', [...GIT_FIXED_CONFIG, ...args], {
    cwd: dir,
    env: gitEnvironment(env),
    encoding,
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

export function parseWorkspaceArguments(args) {
  const [flag, dir, ...rest] = args;
  const mode = MODES[flag];
  if (!mode) throw new Error(`Unknown Codex patch workspace mode: ${flag}`);
  if (!dir || dir.startsWith('--')) throw new Error(`${flag} requires a directory`);
  if (rest.length > 0) throw new Error(`Unexpected argument after ${flag} ${dir}: ${rest[0]}`);
  return { mode, dir: path.resolve(dir) };
}

/** Resolve symlinks through the nearest ancestor that exists, so /tmp and /private/tmp compare equal. */
function realPath(target) {
  const missing = [];
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    missing.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(fs.realpathSync(current), ...missing);
}

function assertUsableWorkspaceDir(dir) {
  const relative = path.relative(realPath(ROOT_DIR), realPath(dir));
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`);
  if (!outside && !path.isAbsolute(relative)) {
    throw new Error(`Refusing to prepare Codex source inside the Frink checkout: ${dir}`);
  }
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    throw new Error(`Refusing to prepare Codex source in a non-empty directory: ${dir}`);
  }
}

function patchBasePath(dir) {
  return path.join(dir, '.git', PATCH_BASE_FILE);
}

/**
 * A workspace may only overwrite the patch it was made from. If the committed patch moved on since
 * (a pull, another workspace, another worktree), writing would silently revert that change.
 */
function assertWorkspaceIsCurrent(dir, manifest) {
  const basePath = patchBasePath(dir);
  if (!fs.existsSync(basePath)) {
    throw new Error(`${dir} is not a Codex workspace prepared by --prepare-source`);
  }
  const base = fs.readFileSync(basePath, 'utf8').trim();
  if (base !== manifest.patchSha256) {
    throw new Error(
      `The Codex patch changed since this workspace was prepared (workspace ${base.slice(0, 12)}, ` +
        `committed ${manifest.patchSha256.slice(0, 12)}). Prepare a fresh workspace and redo the edit there.`,
    );
  }
}

function readPatchManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { manifest, patchPath: path.join(path.dirname(manifestPath), manifest.patch) };
}

/**
 * Lay out the pinned upstream source in `dir` as two commits: the untouched tree, then the Frink
 * patch. The lockfile normalisation a build performs is deliberately left out of both.
 */
export async function prepareSource(
  dir,
  { manifestPath = MANIFEST_PATH, fetch = fetchCodexSource } = {},
) {
  assertUsableWorkspaceDir(dir);
  const { manifest, patchPath } = readPatchManifest(manifestPath);
  const actualPatchSha = sha256File(patchPath);
  if (actualPatchSha !== manifest.patchSha256) {
    throw new Error(
      `Codex provider patch SHA-256 mismatch: expected ${manifest.patchSha256}, got ${actualPatchSha}`,
    );
  }

  const created = !fs.existsSync(dir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const fetchRoot = fs.mkdtempSync(`${dir}-fetch-`);
  try {
    const extracted = await fetch(fetchRoot, manifest);
    if (fs.existsSync(dir)) fs.rmdirSync(dir);
    fs.renameSync(extracted, dir);
  } finally {
    fs.rmSync(fetchRoot, { recursive: true, force: true });
  }

  try {
    git(dir, ['init', '--quiet']);
    // Forced: a file the archive ships must be tracked even where upstream's .gitignore covers it.
    git(dir, ['add', '--all', '--force']);
    git(dir, ['commit', '--quiet', '--no-verify', '-m', `Upstream ${manifest.version}`]);
    git(dir, ['tag', PRISTINE_TAG]);
    git(dir, ['apply', '--index', patchPath]);
    git(dir, ['commit', '--quiet', '--no-verify', '-m', `Frink patch ${manifest.patch}`]);
    git(dir, ['tag', PATCHED_TAG]);
    fs.writeFileSync(patchBasePath(dir), `${manifest.patchSha256}\n`);
  } catch (error) {
    // A half-prepared workspace would only make the retry refuse the directory as non-empty.
    if (created) fs.rmSync(dir, { recursive: true, force: true });
    else
      for (const entry of fs.readdirSync(dir))
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    throw error;
  }
  return dir;
}

function pristineLock(dir) {
  try {
    return git(dir, ['show', `${PRISTINE_TAG}:${CARGO_LOCK}`], { encoding: 'buffer' });
  } catch {
    return null;
  }
}

/**
 * The patch never carries the lockfile, so the only lockfile change it can tolerate is the
 * normalisation a build or test run writes. Anything else would be dropped without a trace.
 */
function assertLockUnchanged(dir, manifest) {
  const pristine = pristineLock(dir);
  if (pristine === null) return;
  const lockPath = path.join(dir, CARGO_LOCK);
  const current = fs.existsSync(lockPath) ? fs.readFileSync(lockPath) : null;
  const normalized = Buffer.from(
    normalizeWorkspaceVersions(
      pristine.toString('utf8'),
      manifest.version.replace(RUST_TAG_PREFIX, ''),
    ),
  );
  if (current === null || !(current.equals(pristine) || current.equals(normalized))) {
    throw new Error(
      `${CARGO_LOCK} changed beyond the build's version normalisation. The Codex patch cannot ` +
        'carry dependency changes; restore the lockfile before writing the patch.',
    );
  }
}

/** The diff of the workspace against pristine upstream, new files included. */
export function canonicalDiff(dir) {
  git(dir, ['add', '--all', '--intent-to-add']);
  return git(dir, CANONICAL_DIFF_ARGS, { encoding: 'buffer' });
}

function treeFromIndex(dir, indexFile, steps) {
  const env = { GIT_INDEX_FILE: indexFile };
  for (const step of steps) git(dir, step, { env });
  return git(dir, ['write-tree'], { env }).trim();
}

/** Applying the written patch to pristine upstream must give exactly the tree being edited. */
function assertPatchReproducesWorkspace(dir, patch) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-codex-index-'));
  try {
    const patchPath = path.join(scratch, 'candidate.patch');
    fs.writeFileSync(patchPath, patch);
    const applied = treeFromIndex(dir, path.join(scratch, 'applied'), [
      ['read-tree', PRISTINE_TAG],
      ['apply', '--cached', patchPath],
    ]);
    const lockReset =
      pristineLock(dir) === null
        ? []
        : [['restore', '--staged', `--source=${PRISTINE_TAG}`, '--', CARGO_LOCK]];
    const edited = treeFromIndex(dir, path.join(scratch, 'edited'), [
      ['read-tree', 'HEAD'],
      ['add', '--all'],
      ...lockReset,
    ]);
    if (applied !== edited) {
      throw new Error('The written Codex patch does not reproduce the edited source tree');
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Untracked paths upstream's .gitignore hides from the patch, other than cargo build output. */
function ignoredPaths(dir) {
  return git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])
    .split('\n')
    .filter((entry) => entry && !/(^|\/)target\/$/.test(entry))
    .sort();
}

export function patchSections(patch) {
  return new Set([...patch.toString('utf8').matchAll(SECTION_PATTERN)].map((match) => match[1]));
}

/**
 * Regenerate the patch file and its single pin from the workspace. Reports the files that entered
 * or left the patch, so a stray build artefact swept in as a new file is noticed.
 */
export function writePatch(dir, { manifestPath = MANIFEST_PATH } = {}) {
  return withWriteLock(manifestPath, () => writePatchLocked(dir, manifestPath));
}

/**
 * Two writes racing on one checkout could both pass the workspace check, then interleave so the
 * patch of one is pinned with the hash of the other. The lock makes the second one wait its turn
 * and then fail that check honestly.
 */
function withWriteLock(manifestPath, write) {
  const lockPath = path.join(path.dirname(manifestPath), WRITE_LOCK_FILE);
  let handle;
  try {
    handle = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    throw new Error(
      `Another --write-patch is updating this Codex patch (${lockPath}). If none is running, ` +
        'a previous one was killed: delete that file and retry.',
    );
  }
  try {
    fs.writeSync(handle, `${process.pid}\n`);
    return write();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  }
}

function writePatchLocked(dir, manifestPath) {
  const manifestSource = fs.readFileSync(manifestPath, 'utf8');
  const { manifest, patchPath } = readPatchManifest(manifestPath);
  assertWorkspaceIsCurrent(dir, manifest);
  assertLockUnchanged(dir, manifest);

  const before = patchSections(fs.readFileSync(patchPath));
  const patch = canonicalDiff(dir);
  if (patch.length === 0) throw new Error('The Codex workspace has no changes against upstream');
  assertPatchReproducesWorkspace(dir, patch);
  if (!patch.equals(fs.readFileSync(patchPath))) fs.writeFileSync(patchPath, patch);

  const patchSha256 = sha256File(patchPath);
  const nextManifest = `${JSON.stringify({ ...manifest, patchSha256 }, null, 2)}\n`;
  if (nextManifest !== manifestSource) fs.writeFileSync(manifestPath, nextManifest);
  fs.writeFileSync(patchBasePath(dir), `${patchSha256}\n`);

  const after = patchSections(patch);
  return {
    patchSha256,
    changed: patchSha256 !== manifest.patchSha256,
    added: [...after].filter((file) => !before.has(file)).sort(),
    removed: [...before].filter((file) => !after.has(file)).sort(),
    ignored: ignoredPaths(dir),
  };
}

/** Run the provider regression tests against a prepared workspace, on the shared cargo target dir. */
export function testOnly(dir, manifest = readManifest()) {
  const rustc = rustcExecutable();
  assertRustVersion(rustc, manifest.rust);
  normalizeCargoLock(dir, manifest);
  runProviderRegressionTests(cargoExecutable(), rustc, path.join(dir, 'codex-rs'));
}

function describeWrite({ patchSha256, changed, added, removed, ignored }) {
  return [
    changed ? `Wrote Codex patch ${patchSha256}` : `Codex patch unchanged (${patchSha256})`,
    ...added.map((file) => `  added to the patch: ${file}`),
    ...removed.map((file) => `  removed from the patch: ${file}`),
    ...ignored.map((file) => `  not in the patch, ignored by upstream's .gitignore: ${file}`),
  ].join('\n');
}

export async function runWorkspaceMode(args) {
  const { mode, dir } = parseWorkspaceArguments(args);
  const manifest = readManifest();
  if (mode === 'prepare') {
    await prepareSource(dir);
    return `Prepared Codex ${manifest.version} with the Frink patch in ${dir}`;
  }
  if (mode === 'write') return describeWrite(writePatch(dir));
  testOnly(dir, manifest);
  return `Codex provider regression tests passed in ${dir}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  runWorkspaceMode(process.argv.slice(2))
    .then((message) => console.log(message))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
