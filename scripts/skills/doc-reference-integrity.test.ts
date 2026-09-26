/**
 * Guards a pointer into the `frink-flows` skill that names a reference file the skill no longer
 * ships. Splitting or renaming a reference topic leaves every citation elsewhere stale, and the
 * agent — the audience for most of them — silently fails the Read and re-derives. The router
 * assertion runs in both directions: adding a topic to `build-skill-content.ts`'s TOPICS without
 * linking it from `SKILL.md` fails here, because a reference the router does not point at is one
 * the agent never opens.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const WORKSPACE_ROOT = process.cwd();

/** Roots whose source may cite skill references. Each must exist — see collectSourceFiles. */
const SOURCE_ROOTS = ['src'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** Generated, vendored, or otherwise not authored here. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '_shared', '.vercel']);

/** The one skill Frink ships. Its `references/` directory is the canonical filename set. */
const SKILL_REFERENCES = 'assets/skills/frink-flows/references';
const SKILL_ROUTER = 'assets/skills/frink-flows/SKILL.md';

/** Prose that points an agent at the skill. */
const SKILL_CITING_MARKDOWN = ['user-docs/frink-flows-skill.md', SKILL_ROUTER];

/** `references/<name>.md` — how TypeScript and prose outside the skill cite a reference. */
const PREFIXED_REFERENCE_PATTERN = /references\/([a-z0-9-]+)\.md/g;

/**
 * A bare `<name>.md` with nothing pathlike in front — how the shipped reference files cross-link
 * siblings, and the form the pre-split docs used. Scanned in Markdown only: TypeScript cites plenty
 * of unrelated `.md` files, and every one it cites carries a path, so the prefixed pattern sees them.
 */
const BARE_REFERENCE_PATTERN = /(?<![\w/-])([a-z0-9]+(?:-[a-z0-9]+)*)\.md\b/g;

const TEST_FILE_PATTERN = /\.(test|spec)\.[a-z]+$/;

function collectSourceFiles(root: string): string[] {
  const absoluteRoot = join(WORKSPACE_ROOT, root);
  // Fail closed: a renamed or moved root would otherwise shrink the scan to nothing and
  // let every assertion below pass while checking far less than it claims.
  if (!existsSync(absoluteRoot)) {
    throw new Error(`Source root "${root}" does not exist — update SOURCE_ROOTS.`);
  }

  const found: string[] = [];
  const pending = [absoluteRoot];

  while (pending.length > 0) {
    const directory = pending.pop() as string;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(absolute);
        continue;
      }
      if (SOURCE_EXTENSIONS.has(extname(entry.name))) found.push(absolute);
    }
  }

  return found;
}

function listMarkdown(root: string): string[] {
  const absoluteRoot = join(WORKSPACE_ROOT, root);
  if (!existsSync(absoluteRoot)) return [];

  return readdirSync(absoluteRoot)
    .filter((name) => extname(name) === '.md')
    .filter((name) => statSync(join(absoluteRoot, name)).isFile())
    .sort();
}

function collectSkillCitations(): { byName: Map<string, string[]>; braceExpansions: string[] } {
  const byName = new Map<string, string[]>();
  const braceExpansions: string[] = [];

  function scan(absolute: string, includeBare: boolean): void {
    const citedBy = relative(WORKSPACE_ROOT, absolute);
    const contents = readFileSync(absolute, 'utf8');

    // `references/{a,b}.md` names no single file, so no existence check can resolve it — and it
    // hides from every filename grep. Ban the form rather than try to expand it.
    if (contents.includes('references/{')) braceExpansions.push(citedBy);

    const patterns = includeBare
      ? [PREFIXED_REFERENCE_PATTERN, BARE_REFERENCE_PATTERN]
      : [PREFIXED_REFERENCE_PATTERN];

    for (const pattern of patterns) {
      for (const [, name] of contents.matchAll(pattern)) {
        byName.set(name, [...(byName.get(name) ?? []), citedBy]);
      }
    }
  }

  for (const root of SOURCE_ROOTS) {
    // Test fixtures invent reference names on purpose (see skill-provisioner.test.ts).
    for (const absolute of collectSourceFiles(root)) {
      if (!TEST_FILE_PATTERN.test(absolute)) scan(absolute, false);
    }
  }

  for (const path of SKILL_CITING_MARKDOWN) scan(join(WORKSPACE_ROOT, path), true);
  for (const name of listMarkdown(SKILL_REFERENCES)) {
    scan(join(WORKSPACE_ROOT, SKILL_REFERENCES, name), true);
  }

  return { byName, braceExpansions };
}

describe('frink-flows skill reference citations', () => {
  const shipped = listMarkdown(SKILL_REFERENCES);
  const { byName, braceExpansions } = collectSkillCitations();

  it('finds the shipped reference files and the citations pointing at them', () => {
    // Either side matching nothing would make every assertion below vacuous.
    expect(shipped.length).toBeGreaterThan(0);
    expect(byName.size).toBeGreaterThan(0);
  });

  it('resolves every cited reference to a file the skill actually ships', () => {
    const shippedNames = new Set(shipped);
    const dangling = [...byName.entries()]
      .filter(([name]) => !shippedNames.has(`${name}.md`))
      .map(([name, citedBy]) => `${name}.md (cited by ${[...new Set(citedBy)].join(', ')})`)
      .sort();

    expect(dangling).toEqual([]);
  });

  it('rejects brace-expanded reference paths', () => {
    expect(braceExpansions).toEqual([]);
  });

  it('keeps SKILL.md a complete router over the shipped references', () => {
    const router = readFileSync(join(WORKSPACE_ROOT, SKILL_ROUTER), 'utf8');

    expect(shipped.filter((name) => !router.includes(name))).toEqual([]);
  });
});
