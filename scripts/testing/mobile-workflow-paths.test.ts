import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

// Guards .github/workflows/mobile.yml path filters. mobile/ imports code from outside its
// own directory, and that workflow is the only place mobile is type-checked and tested, so
// every outside file mobile can reach must trigger it. Otherwise an edit to one of those
// files breaks mobile with every check on the pull request green.
// Plain text parsing: no YAML library is a declared dependency here.

const REPO_ROOT = resolve(__dirname, '../..');
const WORKFLOW_FILE = '.github/workflows/mobile.yml';
const TRIGGERS = ['pull_request', 'push'] as const;
const REQUIRED_PATTERNS = ['mobile/**', WORKFLOW_FILE];
const SOURCE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
const RESOLVE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.d.ts',
  '.js',
  '.cjs',
  '.mjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

type Trigger = (typeof TRIGGERS)[number];
type OutsideImports = { files: string[]; unresolved: string[] };

const toPosix = (path: string) => path.split(sep).join('/');

function isInside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** The `paths:` entries of one trigger, or null when the trigger declares none. */
function triggerPaths(workflow: string, trigger: Trigger): string[] | null {
  const lines = workflow.replace(/\r\n/g, '\n').split('\n');
  const onAt = lines.indexOf('on:');
  if (onAt === -1) return null;
  const triggerAt = lines.findIndex((line, index) => index > onAt && line === `  ${trigger}:`);
  if (triggerAt === -1) return null;

  let pathsAt = -1;
  for (let index = triggerAt + 1; index < lines.length; index += 1) {
    if (/^ {0,2}\S/.test(lines[index])) break;
    if (lines[index] === '    paths:') {
      pathsAt = index;
      break;
    }
  }
  if (pathsAt === -1) return null;

  const paths: string[] = [];
  for (const line of lines.slice(pathsAt + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const entry = /^ {6}- (.+)$/.exec(line);
    if (!entry) break;
    paths.push(entry[1].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  return paths;
}

// GitHub path filters have no brace or extglob syntax, so picomatch must not expand them.
const GITHUB_GLOB = { dot: true, nobrace: true, noextglob: true, nonegate: true };

/** GitHub's rule: a file matches when the last pattern that applies to it is not negated. */
function matchesFilter(patterns: string[], file: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (picomatch(negated ? pattern.slice(1) : pattern, GITHUB_GLOB)(file)) matched = !negated;
  }
  return matched;
}

/** Directories mobile/.gitignore lists: build output a checkout may hold but CI never sees. */
function generatedDirs(mobileRoot: string): Set<string> {
  const ignoreFile = join(mobileRoot, '.gitignore');
  const lines = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8').split(/\r?\n/) : [];
  const dirs = lines.flatMap((line) => /^\/?([^/*!#\s]+)\/$/.exec(line)?.[1] ?? []);
  return new Set(['node_modules', ...dirs]);
}

function sourceFiles(dir: string, skipped: Set<string>): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name) || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, skipped);
    return SOURCE_FILE.test(entry.name) ? [path] : [];
  });
}

function resolveFile(candidate: string): string | null {
  // A `./x.js` specifier names `x.ts` when that is the file on disk.
  const stem = candidate.replace(/\.[cm]?js$/, '');
  for (const base of stem === candidate ? [candidate] : [candidate, stem]) {
    for (const suffix of RESOLVE_SUFFIXES) {
      const path = base + suffix;
      if (existsSync(path) && statSync(path).isFile()) return path;
    }
  }
  return null;
}

/** Where a specifier could point on disk: relative, or through mobile's tsconfig `paths`. */
function candidatePaths(
  specifier: string,
  importer: string,
  mobileRoot: string,
  aliases: Record<string, string[]>,
): string[] {
  if (specifier.startsWith('.')) return [resolve(dirname(importer), specifier)];
  for (const [pattern, targets] of Object.entries(aliases)) {
    const [prefix, suffix] = pattern.split('*');
    if (suffix === undefined) {
      if (specifier === pattern) return targets.map((target) => resolve(mobileRoot, target));
      continue;
    }
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ) {
      const star = specifier.slice(prefix.length, specifier.length - suffix.length);
      return targets.map((target) => resolve(mobileRoot, target.replace('*', star)));
    }
  }
  return [];
}

/**
 * Every file outside mobile/ that mobile's sources reach, followed transitively, plus any
 * import that points outside mobile/ and resolves to nothing.
 */
function outsideImports(mobileRoot: string, repoRoot: string): OutsideImports {
  const tsconfig = ts.parseConfigFileTextToJson(
    'tsconfig.json',
    readFileSync(join(mobileRoot, 'tsconfig.json'), 'utf8'),
  );
  const aliases: Record<string, string[]> = tsconfig.config?.compilerOptions?.paths ?? {};

  const queue = sourceFiles(mobileRoot, generatedDirs(mobileRoot));
  const seen = new Set(queue);
  const files = new Set<string>();
  const unresolved = new Set<string>();

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (!SOURCE_FILE.test(file)) continue;
    const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName: specifier } of [...info.importedFiles, ...info.referencedFiles]) {
      const candidates = candidatePaths(specifier, file, mobileRoot, aliases).filter(
        (candidate) => !candidate.split(sep).includes('node_modules'),
      );
      const outside = candidates.filter((candidate) => !isInside(mobileRoot, candidate));
      if (outside.length === 0) continue;

      const resolved = candidates.map(resolveFile).find((path) => path !== null);
      if (!resolved) {
        unresolved.add(`${toPosix(relative(repoRoot, file))} -> ${specifier}`);
        continue;
      }
      if (isInside(mobileRoot, resolved)) continue;
      files.add(toPosix(relative(repoRoot, resolved)));
      if (!seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return { files: [...files].sort(), unresolved: [...unresolved].sort() };
}

/** Every reason an edit outside mobile/ could break mobile without the workflow running. */
function pathFilterProblems(workflow: string, imports: OutsideImports): string[] {
  const problems = imports.unresolved.map((entry) => `unresolved import: ${entry}`);
  const lists = TRIGGERS.map((trigger) => triggerPaths(workflow, trigger));

  TRIGGERS.forEach((trigger, index) => {
    const paths = lists[index];
    if (!paths || paths.length === 0) {
      problems.push(`${trigger} has no paths list`);
      return;
    }
    for (const pattern of REQUIRED_PATTERNS) {
      if (!paths.includes(pattern)) problems.push(`${trigger} paths is missing ${pattern}`);
    }
    for (const file of imports.files) {
      if (!matchesFilter(paths, file)) problems.push(`${trigger} paths does not cover ${file}`);
    }
  });

  if (JSON.stringify(lists[0]) !== JSON.stringify(lists[1])) {
    problems.push('pull_request and push paths differ');
  }
  return problems;
}

const GOOD_PATHS = ['mobile/**', 'src/shared/**', WORKFLOW_FILE];
const SHARED_IMPORTS: OutsideImports = {
  files: ['src/shared/lib/mobile-channel/index.ts', 'src/shared/types/remote/mobile.ts'],
  unresolved: [],
};

function workflowWith(pullRequestPaths: string[], pushPaths: string[]): string {
  const list = (paths: string[]) => paths.map((path) => `      - '${path}'`).join('\n');
  return `name: Mobile companion

on:
  pull_request:
    paths:
${list(pullRequestPaths)}
  push:
    branches: [main]
    paths:
      # A comment between entries is not an entry.
${list(pushPaths)}
  workflow_dispatch:

jobs:
  validate:
    steps:
      - run: bun run check
`;
}

describe('mobile workflow path filters', () => {
  const workflow = readFileSync(join(REPO_ROOT, WORKFLOW_FILE), 'utf8');
  const imports = outsideImports(join(REPO_ROOT, 'mobile'), REPO_ROOT);

  it('finds the shared code mobile imports', () => {
    expect(imports.files).toContain('src/shared/lib/mobile-channel/index.ts');
    expect(imports.files).toContain('src/shared/types/task-signal.ts');
  });

  it('runs on every file outside mobile/ that mobile can reach', () => {
    expect(pathFilterProblems(workflow, imports)).toEqual([]);
  });
});

describe('pathFilterProblems', () => {
  it('accepts a filter that covers every reached file on both triggers', () => {
    expect(pathFilterProblems(workflowWith(GOOD_PATHS, GOOD_PATHS), SHARED_IMPORTS)).toEqual([]);
  });

  it('accepts CRLF line endings from a Windows checkout', () => {
    const crlf = workflowWith(GOOD_PATHS, GOOD_PATHS).replace(/\n/g, '\r\n');
    expect(pathFilterProblems(crlf, SHARED_IMPORTS)).toEqual([]);
  });

  it('flags a trigger narrowed back to an enumerated list', () => {
    const narrowed = ['mobile/**', 'src/shared/types/remote/mobile.ts', WORKFLOW_FILE];
    expect(pathFilterProblems(workflowWith(GOOD_PATHS, narrowed), SHARED_IMPORTS)).toEqual([
      'push paths does not cover src/shared/lib/mobile-channel/index.ts',
      'pull_request and push paths differ',
    ]);
  });

  it('flags a single-level glob, which does not reach nested files', () => {
    const shallow = ['mobile/**', 'src/shared/*', WORKFLOW_FILE];
    const problems = pathFilterProblems(workflowWith(shallow, shallow), SHARED_IMPORTS);
    expect(problems).toContain(
      'pull_request paths does not cover src/shared/types/remote/mobile.ts',
    );
    expect(problems).toContain('push paths does not cover src/shared/types/remote/mobile.ts');
  });

  it('flags a later negated pattern that excludes a reached file', () => {
    const negated = [...GOOD_PATHS, '!src/shared/lib/**'];
    expect(pathFilterProblems(workflowWith(negated, negated), SHARED_IMPORTS)).toEqual([
      'pull_request paths does not cover src/shared/lib/mobile-channel/index.ts',
      'push paths does not cover src/shared/lib/mobile-channel/index.ts',
    ]);
  });

  it('flags a brace pattern, which GitHub matches literally', () => {
    const braces = ['mobile/**', 'src/{shared,main}/**', WORKFLOW_FILE];
    const problems = pathFilterProblems(workflowWith(braces, braces), SHARED_IMPORTS);
    expect(problems).toContain('push paths does not cover src/shared/types/remote/mobile.ts');
  });

  it('flags a reached file outside the watched directories', () => {
    const imports = { files: ['src/main/lib/helper.ts'], unresolved: [] };
    expect(pathFilterProblems(workflowWith(GOOD_PATHS, GOOD_PATHS), imports)).toEqual([
      'pull_request paths does not cover src/main/lib/helper.ts',
      'push paths does not cover src/main/lib/helper.ts',
    ]);
  });

  it('flags a missing paths list instead of passing with nothing checked', () => {
    const noPaths = workflowWith(GOOD_PATHS, GOOD_PATHS).replace(/^ {4}paths:\n/gm, '');
    expect(pathFilterProblems(noPaths, SHARED_IMPORTS)).toEqual([
      'pull_request has no paths list',
      'push has no paths list',
    ]);
    expect(pathFilterProblems(workflowWith([], GOOD_PATHS), SHARED_IMPORTS)).toContain(
      'pull_request has no paths list',
    );
  });

  it('flags a workflow whose trigger or on block is gone', () => {
    const noPush = workflowWith(GOOD_PATHS, GOOD_PATHS).replace('  push:\n', '  merge_group:\n');
    expect(pathFilterProblems(noPush, SHARED_IMPORTS)).toEqual([
      'push has no paths list',
      'pull_request and push paths differ',
    ]);
    expect(pathFilterProblems('name: Mobile companion\n', SHARED_IMPORTS)).toEqual([
      'pull_request has no paths list',
      'push has no paths list',
    ]);
  });

  it('flags a filter that stopped watching mobile/ or the workflow itself', () => {
    const paths = ['src/shared/**'];
    expect(pathFilterProblems(workflowWith(paths, paths), SHARED_IMPORTS)).toEqual([
      'pull_request paths is missing mobile/**',
      `pull_request paths is missing ${WORKFLOW_FILE}`,
      'push paths is missing mobile/**',
      `push paths is missing ${WORKFLOW_FILE}`,
    ]);
  });

  it('flags an import that points outside mobile/ and resolves to nothing', () => {
    const imports = { files: [], unresolved: ['mobile/src/a.ts -> @frink/shared/gone'] };
    expect(pathFilterProblems(workflowWith(GOOD_PATHS, GOOD_PATHS), imports)).toEqual([
      'unresolved import: mobile/src/a.ts -> @frink/shared/gone',
    ]);
  });
});

describe('outsideImports', () => {
  let root = '';

  function write(file: string, content: string): void {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function fixture(files: Record<string, string>): OutsideImports {
    root = mkdtempSync(join(tmpdir(), 'mobile-workflow-paths-'));
    write(
      'mobile/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          paths: { zod: ['./node_modules/zod'], '@frink/shared/*': ['../src/shared/*'] },
        },
      }),
    );
    for (const [file, content] of Object.entries(files)) write(file, content);
    return outsideImports(join(root, 'mobile'), root);
  }

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('follows alias, relative, type-only, re-export, dynamic and require imports', () => {
    const imports = fixture({
      'mobile/src/a.ts': [
        "import { a } from '@frink/shared/lib/alias';",
        "import type { T } from '@frink/shared/types/only';",
        "export * from '@frink/shared/lib/reexport';",
        "const lazy = import('@frink/shared/lib/dynamic');",
        "import { z } from 'zod';",
        "import { local } from './local';",
      ].join('\n'),
      'mobile/src/local.ts': 'export const local = 1;',
      'mobile/tests/fixture.ts': "import { r } from '../../src/shared/lib/relative';",
      'mobile/metro.config.cjs': "const c = require('../src/shared/lib/required');",
      'mobile/node_modules/dep/index.ts': "import '../../../src/shared/lib/ignored';",
      'src/shared/lib/alias/index.ts': 'export const a = 1;',
      'src/shared/types/only.ts': 'export type T = 1;',
      'src/shared/lib/reexport.ts': 'export const e = 1;',
      'src/shared/lib/dynamic.ts': 'export const d = 1;',
      'src/shared/lib/relative.ts': 'export const r = 1;',
      'src/shared/lib/required.js': 'module.exports = {};',
      'src/shared/lib/ignored.ts': 'export const i = 1;',
    });
    expect(imports).toEqual({
      files: [
        'src/shared/lib/alias/index.ts',
        'src/shared/lib/dynamic.ts',
        'src/shared/lib/reexport.ts',
        'src/shared/lib/relative.ts',
        'src/shared/lib/required.js',
        'src/shared/types/only.ts',
      ],
      unresolved: [],
    });
  });

  it('follows a shared file that imports from outside the shared directory', () => {
    const imports = fixture({
      'mobile/src/a.ts': "import { a } from '@frink/shared/lib/a';",
      'src/shared/lib/a.ts': "import { b } from './b';\nexport const a = b;",
      'src/shared/lib/b.ts': "import { c } from '../../main/c';\nexport const b = c;",
      'src/main/c.ts': 'export const c = 1;',
    });
    expect(imports.files).toEqual(['src/main/c.ts', 'src/shared/lib/a.ts', 'src/shared/lib/b.ts']);
  });

  it('resolves a .js specifier to the TypeScript file it names', () => {
    const imports = fixture({
      'mobile/src/a.ts': "import { a } from '@frink/shared/lib/a.js';",
      'src/shared/lib/a.ts': "import { b } from './b.js';\nexport const a = b;",
      'src/shared/lib/b.tsx': 'export const b = 1;',
    });
    expect(imports).toEqual({
      files: ['src/shared/lib/a.ts', 'src/shared/lib/b.tsx'],
      unresolved: [],
    });
  });

  it('skips generated directories that mobile/.gitignore lists', () => {
    const imports = fixture({
      'mobile/.gitignore': 'node_modules/\n.expo/\ndist/\n*.tsbuildinfo\n',
      'mobile/dist/bundle.js': "require('../../src/shared/lib/bundled');",
      'mobile/src/dist.ts': "import { a } from '@frink/shared/lib/a';",
      'src/shared/lib/a.ts': 'export const a = 1;',
      'src/shared/lib/bundled.ts': 'export const bundled = 1;',
    });
    expect(imports.files).toEqual(['src/shared/lib/a.ts']);
  });

  it('reports an outside import that resolves to nothing', () => {
    const imports = fixture({
      'mobile/src/a.ts': "import { a } from '@frink/shared/lib/gone';\nimport './missing';",
    });
    expect(imports).toEqual({
      files: [],
      unresolved: ['mobile/src/a.ts -> @frink/shared/lib/gone'],
    });
  });
});
