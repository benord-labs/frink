import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROOT_DIR } from './build-codex-frink.mjs';
import {
  parseWorkspaceArguments,
  patchSections,
  prepareSource,
  writePatch,
} from './codex-patch-workspace.mjs';
import { sha256File } from './http-download.mjs';

const VERSION = 'rust-v1.2.3';
const PATCH_NAME = 'frink.patch';
const PRISTINE_LOCK = '[[package]]\nname = "codex-core"\nversion = "0.0.0"\n';
/** What a hand-written patch looks like before the tool has ever rewritten it. */
const SEED_PATCH = [
  'diff --git a/text.txt b/text.txt',
  '--- a/text.txt',
  '+++ b/text.txt',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '',
].join('\n');

let root: string;
let manifestPath: string;
let patchPath: string;

/** Stands in for the network fetch: a tiny upstream tree with the shapes the real one has. */
async function fetchSyntheticUpstream(destRoot: string, manifest: { version: string }) {
  const tree = path.join(destRoot, `codex-${manifest.version}`);
  fs.mkdirSync(path.join(tree, 'codex-rs'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'text.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(tree, 'untouched.txt'), 'left alone\n');
  fs.writeFileSync(path.join(tree, 'no-newline.txt'), 'first\nlast');
  fs.writeFileSync(path.join(tree, 'schema.bin'), Buffer.from([0, 1, 2, 0, 255, 254]));
  fs.writeFileSync(path.join(tree, '.gitignore'), 'target/\n');
  fs.writeFileSync(path.join(tree, 'codex-rs', 'Cargo.lock'), PRISTINE_LOCK);
  return tree;
}

function pinPatch() {
  const manifest = { version: VERSION, patch: PATCH_NAME, patchSha256: sha256File(patchPath) };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function prepare(name: string) {
  return prepareSource(path.join(root, name), { manifestPath, fetch: fetchSyntheticUpstream });
}

function pinnedSha() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).patchSha256;
}

/** The text of one file's section, so a test can assert the others did not move. */
function section(patch: string, file: string) {
  const start = patch.indexOf(`diff --git a/${file} b/${file}\n`);
  const next = patch.indexOf('\ndiff --git ', start);
  return patch.slice(start, next === -1 ? undefined : next + 1);
}

/**
 * Take the seed patch through the tool once, adding the cases a text hunk does not cover: a new
 * file, a binary change and a file with no trailing newline. Leaves the canonical patch pinned.
 */
async function writeCanonicalPatch() {
  const workspace = await prepare('seed');
  fs.writeFileSync(path.join(workspace, 'added.txt'), 'brand new\n');
  fs.writeFileSync(path.join(workspace, 'schema.bin'), Buffer.from([9, 0, 8, 0, 7, 255]));
  fs.writeFileSync(path.join(workspace, 'no-newline.txt'), 'first\nchanged');
  return writePatch(workspace, { manifestPath });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-codex-workspace-test-'));
  manifestPath = path.join(root, 'manifest.json');
  patchPath = path.join(root, PATCH_NAME);
  fs.writeFileSync(patchPath, SEED_PATCH);
  pinPatch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseWorkspaceArguments', () => {
  it('reads each mode with the directory it works on', () => {
    expect(parseWorkspaceArguments(['--prepare-source', '/tmp/codex'])).toEqual({
      mode: 'prepare',
      dir: path.resolve('/tmp/codex'),
    });
    expect(parseWorkspaceArguments(['--write-patch', '/tmp/codex']).mode).toBe('write');
    expect(parseWorkspaceArguments(['--test-only', '/tmp/codex']).mode).toBe('test');
  });

  it('refuses a mode with no directory, or with anything after it', () => {
    expect(() => parseWorkspaceArguments(['--write-patch'])).toThrow(
      '--write-patch requires a directory',
    );
    expect(() => parseWorkspaceArguments(['--write-patch', '--test'])).toThrow(
      '--write-patch requires a directory',
    );
    expect(() => parseWorkspaceArguments(['--test-only', '/tmp/codex', 'codex-core'])).toThrow(
      'Unexpected argument after --test-only',
    );
    expect(() => parseWorkspaceArguments(['--target', 'darwin-arm64'])).toThrow(
      'Unknown Codex patch workspace mode',
    );
  });
});

describe('prepareSource', () => {
  it('refuses a directory that already holds something', async () => {
    const occupied = path.join(root, 'occupied');
    fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(occupied, 'notes.txt'), 'mine');
    await expect(
      prepareSource(occupied, { manifestPath, fetch: fetchSyntheticUpstream }),
    ).rejects.toThrow('non-empty directory');
    expect(fs.readdirSync(occupied)).toEqual(['notes.txt']);
  });

  it('refuses a directory inside the Frink checkout, which would nest a repository in it', async () => {
    const nested = path.join(ROOT_DIR, 'codex-workspace-that-must-not-exist');
    await expect(
      prepareSource(nested, { manifestPath, fetch: fetchSyntheticUpstream }),
    ).rejects.toThrow('inside the Frink checkout');
    expect(fs.existsSync(nested)).toBe(false);
  });

  it('treats a sibling whose name only starts with two dots as inside the checkout', async () => {
    const lookalike = path.join(ROOT_DIR, '..codex-workspace-that-must-not-exist');
    await expect(
      prepareSource(lookalike, { manifestPath, fetch: fetchSyntheticUpstream }),
    ).rejects.toThrow('inside the Frink checkout');
  });

  it('removes a workspace it could not finish, so a retry is not refused', async () => {
    fs.writeFileSync(patchPath, SEED_PATCH.replace('-two', '-not upstream'));
    pinPatch();
    const target = path.join(root, 'half-prepared');

    await expect(
      prepareSource(target, { manifestPath, fetch: fetchSyntheticUpstream }),
    ).rejects.toThrow();
    expect(fs.existsSync(target)).toBe(false);

    fs.mkdirSync(target);
    await expect(
      prepareSource(target, { manifestPath, fetch: fetchSyntheticUpstream }),
    ).rejects.toThrow();
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('refuses a patch whose bytes no longer match the pin', async () => {
    fs.appendFileSync(patchPath, '\n');
    await expect(prepare('drifted')).rejects.toThrow('Codex provider patch SHA-256 mismatch');
  });

  it('applies the patch on top of the upstream tree and leaves nothing behind to clean up', async () => {
    const workspace = await prepare('fresh');
    expect(fs.readFileSync(path.join(workspace, 'text.txt'), 'utf8')).toBe('one\nTWO\nthree\n');
    expect(fs.readdirSync(root).filter((entry) => entry.includes('-fetch-'))).toEqual([]);
  });
});

describe('writePatch', () => {
  it('rewrites a hand-written patch into the canonical format and moves the single pin', async () => {
    const result = await writeCanonicalPatch();

    const patch = fs.readFileSync(patchPath, 'utf8');
    expect(result.changed).toBe(true);
    expect(result.added).toEqual(['added.txt', 'no-newline.txt', 'schema.bin']);
    expect(patch).toContain('new file mode 100644');
    expect(patch).toContain('GIT binary patch');
    expect(patch).toContain('\\ No newline at end of file');
    expect(patch).toMatch(/^index [0-9a-f]{40}\.\.[0-9a-f]{40} 100644$/m);
    expect(pinnedSha()).toBe(sha256File(patchPath));
    expect(pinnedSha()).toBe(result.patchSha256);
  });

  it('reproduces the committed patch byte for byte when nothing was edited', async () => {
    await writeCanonicalPatch();
    const patch = fs.readFileSync(patchPath);
    const manifest = fs.readFileSync(manifestPath);

    const result = writePatch(await prepare('untouched'), { manifestPath });

    expect(result).toMatchObject({ changed: false, added: [], removed: [], ignored: [] });
    expect(fs.readFileSync(patchPath).equals(patch)).toBe(true);
    expect(fs.readFileSync(manifestPath).equals(manifest)).toBe(true);
  });

  it('changes only the edited file section and the pin', async () => {
    await writeCanonicalPatch();
    const before = fs.readFileSync(patchPath, 'utf8');
    const pinBefore = pinnedSha();
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
    const workspace = await prepare('one-edit');

    fs.writeFileSync(path.join(workspace, 'text.txt'), 'one\nTWO\nthree\nfour\n');
    const result = writePatch(workspace, { manifestPath });

    const after = fs.readFileSync(patchPath, 'utf8');
    expect(section(after, 'text.txt')).not.toBe(section(before, 'text.txt'));
    expect(section(after, 'text.txt')).toContain('+four');
    for (const file of ['added.txt', 'no-newline.txt', 'schema.bin']) {
      expect(section(after, file)).toBe(section(before, file));
    }
    expect([...patchSections(after)]).toEqual([...patchSections(before)]);
    expect(result).toMatchObject({ changed: true, added: [], removed: [] });
    expect(pinnedSha()).not.toBe(pinBefore);
    expect(pinnedSha()).toBe(sha256File(patchPath));
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(
      manifestBefore.replace(pinBefore, pinnedSha()),
    );
  });

  it('carries a file that was created but never staged, and names it', async () => {
    await writeCanonicalPatch();
    const workspace = await prepare('new-file');

    fs.writeFileSync(path.join(workspace, 'later.txt'), 'created during the edit\n');
    const result = writePatch(workspace, { manifestPath });

    expect(result.added).toEqual(['later.txt']);
    expect(section(fs.readFileSync(patchPath, 'utf8'), 'later.txt')).toContain(
      '+created during the edit',
    );
  });

  it('names a file an edit reverted back to upstream', async () => {
    await writeCanonicalPatch();
    const workspace = await prepare('reverted');

    fs.rmSync(path.join(workspace, 'added.txt'));
    expect(writePatch(workspace, { manifestPath }).removed).toEqual(['added.txt']);
  });

  it('leaves out build output that upstream ignores', async () => {
    await writeCanonicalPatch();
    const patch = fs.readFileSync(patchPath);
    const workspace = await prepare('built');

    fs.mkdirSync(path.join(workspace, 'target'));
    fs.writeFileSync(path.join(workspace, 'target', 'codex'), 'binary');
    const result = writePatch(workspace, { manifestPath });

    expect(fs.readFileSync(patchPath).equals(patch)).toBe(true);
    expect(result.ignored).toEqual([]);
  });

  it('names a new file that upstream ignores, which the patch cannot carry', async () => {
    await writeCanonicalPatch();
    const workspace = await prepare('ignored-file');

    fs.writeFileSync(path.join(workspace, '.gitignore'), 'target/\n*.local\n');
    fs.writeFileSync(path.join(workspace, 'settings.local'), 'meant for the patch\n');
    const result = writePatch(workspace, { manifestPath });

    expect(result.ignored).toEqual(['settings.local']);
    expect(patchSections(fs.readFileSync(patchPath))).not.toContain('settings.local');
  });

  it('leaves out the lockfile normalisation a build or test run writes', async () => {
    await writeCanonicalPatch();
    const patch = fs.readFileSync(patchPath);
    const workspace = await prepare('normalised');

    fs.writeFileSync(
      path.join(workspace, 'codex-rs', 'Cargo.lock'),
      PRISTINE_LOCK.replace('0.0.0', '1.2.3'),
    );
    expect(writePatch(workspace, { manifestPath }).changed).toBe(false);
    expect(fs.readFileSync(patchPath).equals(patch)).toBe(true);
  });

  it('refuses any other lockfile change instead of dropping it, and writes nothing', async () => {
    await writeCanonicalPatch();
    const patch = fs.readFileSync(patchPath);
    const workspace = await prepare('new-dependency');

    fs.appendFileSync(path.join(workspace, 'codex-rs', 'Cargo.lock'), '[[package]]\n');
    fs.writeFileSync(path.join(workspace, 'text.txt'), 'edited\n');
    expect(() => writePatch(workspace, { manifestPath })).toThrow(
      'The Codex patch cannot carry dependency changes',
    );
    fs.rmSync(path.join(workspace, 'codex-rs', 'Cargo.lock'));
    expect(() => writePatch(workspace, { manifestPath })).toThrow(
      'The Codex patch cannot carry dependency changes',
    );
    expect(fs.readFileSync(patchPath).equals(patch)).toBe(true);
  });

  it('refuses to write from a workspace prepared before the committed patch last changed', async () => {
    await writeCanonicalPatch();
    const stale = await prepare('stale');
    const current = await prepare('current');

    fs.writeFileSync(path.join(current, 'untouched.txt'), 'a teammate changed this\n');
    writePatch(current, { manifestPath });
    const theirs = fs.readFileSync(patchPath);

    fs.writeFileSync(path.join(stale, 'text.txt'), 'one\nTWO\nthree\nmine\n');
    expect(() => writePatch(stale, { manifestPath })).toThrow(
      'The Codex patch changed since this workspace was prepared',
    );
    expect(fs.readFileSync(patchPath).equals(theirs)).toBe(true);
  });

  it('keeps accepting writes from the workspace that made the last change', async () => {
    await writeCanonicalPatch();
    const workspace = await prepare('repeated');

    fs.writeFileSync(path.join(workspace, 'text.txt'), 'one\nTWO\nthree\nfirst\n');
    writePatch(workspace, { manifestPath });
    fs.writeFileSync(path.join(workspace, 'text.txt'), 'one\nTWO\nthree\nsecond\n');

    expect(writePatch(workspace, { manifestPath }).changed).toBe(true);
    expect(fs.readFileSync(patchPath, 'utf8')).toContain('+second');
  });

  it('refuses to write while another write to the same patch holds the lock', async () => {
    await writeCanonicalPatch();
    const patch = fs.readFileSync(patchPath);
    const manifest = fs.readFileSync(manifestPath);
    const workspace = await prepare('contended');
    const lock = path.join(root, '.write-patch.lock');
    fs.writeFileSync(lock, '12345\n');

    fs.writeFileSync(path.join(workspace, 'text.txt'), 'one\nTWO\nthree\nmine\n');
    expect(() => writePatch(workspace, { manifestPath })).toThrow(
      'Another --write-patch is updating this Codex patch',
    );
    expect(fs.readFileSync(patchPath).equals(patch)).toBe(true);
    expect(fs.readFileSync(manifestPath).equals(manifest)).toBe(true);

    fs.rmSync(lock);
    expect(writePatch(workspace, { manifestPath }).changed).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('releases the lock when a write is refused', async () => {
    await writeCanonicalPatch();
    const workspace = await prepare('refused');
    fs.appendFileSync(path.join(workspace, 'codex-rs', 'Cargo.lock'), '[[package]]\n');

    expect(() => writePatch(workspace, { manifestPath })).toThrow('dependency changes');
    expect(fs.existsSync(path.join(root, '.write-patch.lock'))).toBe(false);
  });

  it('refuses a directory that --prepare-source did not create', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(() => writePatch(plain, { manifestPath })).toThrow(
      'not a Codex workspace prepared by --prepare-source',
    );
  });

  it('carries the deletion of an upstream file', async () => {
    await writeCanonicalPatch();
    const workspace = await prepare('deleted');

    fs.rmSync(path.join(workspace, 'untouched.txt'));
    const result = writePatch(workspace, { manifestPath });

    expect(result.added).toEqual(['untouched.txt']);
    expect(section(fs.readFileSync(patchPath, 'utf8'), 'untouched.txt')).toContain(
      'deleted file mode 100644',
    );
  });

  it('refuses a workspace reverted all the way to upstream rather than writing an empty patch', async () => {
    const workspace = await prepare('emptied');
    fs.writeFileSync(path.join(workspace, 'text.txt'), 'one\ntwo\nthree\n');
    expect(() => writePatch(workspace, { manifestPath })).toThrow('no changes against upstream');
    expect(fs.readFileSync(patchPath, 'utf8')).toBe(SEED_PATCH);
  });

  it('writes the same bytes whatever the developer has configured git to do', async () => {
    await writeCanonicalPatch();
    const patch = fs.readFileSync(patchPath);

    const gitconfig = path.join(root, 'hostile.gitconfig');
    fs.writeFileSync(
      gitconfig,
      [
        '[diff]',
        '  noprefix = true',
        '  algorithm = patience',
        '  context = 9',
        '  renames = copies',
        '[core]',
        '  abbrev = 4',
        '  autocrlf = true',
        '[commit]',
        '  gpgsign = true',
        '[color]',
        '  ui = always',
        '',
      ].join('\n'),
    );
    vi.stubEnv('GIT_CONFIG_GLOBAL', gitconfig);
    vi.stubEnv('GIT_DIFF_OPTS', '--unified=0');
    vi.stubEnv('GIT_EXTERNAL_DIFF', 'false');

    const result = writePatch(await prepare('hostile'), { manifestPath });

    expect(result.changed).toBe(false);
    expect(fs.readFileSync(patchPath).equals(patch)).toBe(true);
  });
});
