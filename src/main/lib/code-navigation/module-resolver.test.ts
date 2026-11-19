import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearResolverCache, resolveDefinition, resolveModuleSpecifier } from './module-resolver';
import { findOwningCompilerOptions } from './tsconfig-owner';

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
}

const VITE_PROJECT = {
  'tsconfig.json': JSON.stringify({
    files: [],
    references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
  }),
  'tsconfig.app.json': JSON.stringify({
    compilerOptions: { moduleResolution: 'bundler', paths: { '@/*': ['./src/*'] } },
    include: ['src'],
  }),
  'tsconfig.node.json': JSON.stringify({
    compilerOptions: { moduleResolution: 'bundler', types: ['node'] },
    include: ['vite.config.ts'],
  }),
  'vite.config.ts': 'export default {};',
  'src/styles/theme.scss': '$x: 1;',
};

describe('config ownership', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'code-nav-owner-'));
  });

  afterEach(async () => {
    clearResolverCache();
    await rm(root, { recursive: true, force: true });
  });

  it('resolves an alias through the referenced app config of a solution-style root', async () => {
    await writeTree(root, { ...VITE_PROJECT, 'src/lib/x.ts': 'export const a = 1;' });
    const result = resolveModuleSpecifier(root, join(root, 'src/App.tsx'), '@/lib/x');
    expect(result).toBe(join(root, 'src/lib/x.ts'));
  });

  it('falls back to a solution root that holds the paths its referenced config lacks', async () => {
    await writeTree(root, {
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [{ path: './tsconfig.app.json' }],
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
      }),
      'tsconfig.app.json': JSON.stringify({
        compilerOptions: { moduleResolution: 'bundler' },
        include: ['src'],
      }),
      'src/lib/x.ts': 'export const a = 1;',
      'src/App.tsx': 'import { a } from "@/lib/x";',
    });
    const result = resolveModuleSpecifier(root, join(root, 'src/App.tsx'), '@/lib/x');
    expect(result).toBe(join(root, 'src/lib/x.ts'));
  });

  it('gives a file the options of the referenced config that includes it', async () => {
    await writeTree(root, VITE_PROJECT);
    const owner = findOwningCompilerOptions(root, join(root, 'vite.config.ts'));
    expect(owner.configPath).toBe(join(root, 'tsconfig.node.json'));
  });

  it('resolves a monorepo package alias inherited through extends', async () => {
    await writeTree(root, {
      'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler' } }),
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: { moduleResolution: 'bundler', paths: { '~/*': ['./src/*'] } },
      }),
      'packages/ui/tsconfig.json': JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { baseUrl: '.' },
        include: ['src'],
      }),
      'packages/ui/src/lib/y.ts': 'export const b = 1;',
    });
    const containing = join(root, 'packages/ui/src/a.ts');
    await writeFile(containing, 'import { b } from "~/lib/y";');
    const result = resolveModuleSpecifier(root, containing, '~/lib/y');
    expect(result).toBe(join(root, 'packages/ui/src/lib/y.ts'));
  });

  it('resolves each barrel hop with the config of the file it is in', async () => {
    await writeTree(root, {
      'packages/app/tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@ui': ['../ui/src/index.ts'] } },
        include: ['src'],
      }),
      'packages/ui/tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '~/*': ['./src/*'] } },
        include: ['src'],
      }),
      'packages/ui/src/index.ts': 'export * from "~/button";\n',
      'packages/ui/src/button.ts': 'export const Button = 1;\n',
    });
    const source = 'import { Button } from "@ui";\nButton;';
    const result = resolveDefinition({
      projectPath: root,
      containingFile: join(root, 'packages/app/src/main.ts'),
      fileContent: source,
      offset: source.lastIndexOf('Button'),
    });
    expect(result).toMatchObject({ path: join(root, 'packages/ui/src/button.ts'), line: 1 });
  });

  it('gives a file no config includes the options of the config with paths', async () => {
    await writeTree(root, {
      ...VITE_PROJECT,
      'tsconfig.app.json': JSON.stringify({
        compilerOptions: { moduleResolution: 'bundler', paths: { '@/*': ['./src/*'] } },
        include: ['src'],
        exclude: ['src/**/*.test.ts'],
      }),
      'src/lib/x.ts': 'export const a = 1;',
    });
    const owner = findOwningCompilerOptions(root, join(root, 'src/lib/x.test.ts'));
    expect(owner.configPath).toBe(join(root, 'tsconfig.app.json'));
  });

  it('resolves through jsconfig.json in a JavaScript project', async () => {
    await writeTree(root, {
      'jsconfig.json': JSON.stringify({
        compilerOptions: { allowJs: true, baseUrl: '.', paths: { '#/*': ['./src/*'] } },
      }),
      'src/util.js': 'export const u = 1;',
      'src/main.js': 'import { u } from "#/util";',
    });
    const result = resolveModuleSpecifier(root, join(root, 'src/main.js'), '#/util');
    expect(result).toBe(join(root, 'src/util.js'));
  });

  it('picks up an edited paths entry without clearing the cache', async () => {
    const config = (alias: string) =>
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { [alias]: ['./src/*'] } } });
    await writeTree(root, { 'tsconfig.json': config('@old/*'), 'src/z.ts': 'export {};' });
    const containing = join(root, 'src/index.ts');
    expect(resolveModuleSpecifier(root, containing, '@new/z')).toBeNull();

    await writeFile(join(root, 'tsconfig.json'), config('@new/*'));
    const later = new Date(Date.now() + 5_000);
    await utimes(join(root, 'tsconfig.json'), later, later);

    expect(resolveModuleSpecifier(root, containing, '@new/z')).toBe(join(root, 'src/z.ts'));
  });

  it('treats a folder whose name starts with two dots as inside the project', async () => {
    await writeTree(root, VITE_PROJECT);
    const owner = findOwningCompilerOptions(root, join(root, '..generated/a.ts'));
    expect(owner.configPath).not.toBeNull();
  });

  it('matches a paths key without a wildcard only exactly', async () => {
    await writeTree(root, {
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@ui': ['./src/ui'] } },
      }),
      'src/ui/kit/x.scss': '$x: 1;',
    });
    const containing = join(root, 'src/App.tsx');
    expect(resolveModuleSpecifier(root, containing, '@uikit/x.scss')).toBeNull();
  });

  it('resolves an aliased asset when paths is set without baseUrl', async () => {
    await writeTree(root, VITE_PROJECT);
    const result = resolveModuleSpecifier(root, join(root, 'src/App.tsx'), '@/styles/theme');
    expect(result).toBe(join(root, 'src/styles/theme.scss'));
  });
});

describe('resolveDefinition', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'code-nav-def-'));
    await writeTree(root, {
      ...VITE_PROJECT,
      'src/lib/button.ts': 'import { x } from "./x";\n\nexport function Button() {}\n',
      'src/lib/x.ts':
        '// x\nexport const a = 1, size = 2;\nconst Main = 3;\nexport default Main;\n',
      'src/lib/local.ts': 'import { a as inner } from "./x";\nexport { inner as relabelled };\n',
      'src/lib/index.ts':
        'export * from "./button";\nexport { size as sz } from "./x";\nexport * from "./local";\n',
      'src/lib/cycle-a.ts': 'export * from "./cycle-b";\n',
      'src/lib/cycle-b.ts': 'export * from "./cycle-a";\n',
      'src/ui/Card.tsx': '\nexport default function CardView() {}\n',
      'src/ui/index.ts':
        'export { default as Card } from "./Card";\nexport { default } from "./Card";\n',
    });
  });

  afterEach(async () => {
    clearResolverCache();
    await rm(root, { recursive: true, force: true });
  });

  function definitionAt(source: string, marker: string) {
    return resolveDefinition({
      projectPath: root,
      containingFile: join(root, 'src/App.tsx'),
      fileContent: source,
      offset: source.lastIndexOf(marker),
    });
  }

  it.each([
    ['a named import', 'import { a } from "@/lib/x";\na;', 'a;', 'src/lib/x.ts', 2, 14],
    ['an aliased import', 'import { size as s } from "@/lib/x";\ns;', 's;', 'src/lib/x.ts', 2, 21],
    ['a default import', 'import M from "@/lib/x";\nM;', 'M;', 'src/lib/x.ts', 3, 7],
    [
      'an export * barrel',
      'import { Button } from "@/lib";\nButton;',
      'Button;',
      'src/lib/button.ts',
      3,
      17,
    ],
    ['a renamed re-export', 'import { sz } from "@/lib";\nsz;', 'sz;', 'src/lib/x.ts', 2, 21],
    [
      'a local re-export of an import',
      'import { relabelled } from "@/lib";\nrelabelled;',
      'relabelled;',
      'src/lib/x.ts',
      2,
      14,
    ],
    [
      'a default re-exported under a name',
      'import { Card } from "@/ui";\nCard;',
      'Card;',
      'src/ui/Card.tsx',
      2,
      25,
    ],
    [
      'a default re-exported as default',
      'import C from "@/ui";\nC;',
      'C;',
      'src/ui/Card.tsx',
      2,
      25,
    ],
  ])('lands on the declaration for %s', (_label, source, marker, file, line, column) => {
    expect(definitionAt(source, marker)).toMatchObject({ path: join(root, file), line, column });
  });

  it('spans the declared name with endColumn', () => {
    const result = definitionAt('import { Button } from "@/lib/button";\nButton;', 'Button;');
    expect(result).toMatchObject({ line: 3, column: 17, endColumn: 23 });
  });

  it('opens the top of the file when an export * cycle never declares the name', () => {
    const result = definitionAt('import { gone } from "@/lib/cycle-a";\ngone;', 'gone;');
    expect(result).toEqual({
      path: join(root, 'src/lib/cycle-a.ts'),
      line: 1,
      column: 1,
      endColumn: 1,
    });
  });

  it('returns null for a local that shadows an import, so the editor answers', () => {
    const source = 'import { a } from "@/lib/x";\nfunction f(a: number) { return a; }';
    expect(definitionAt(source, 'a; }')).toBeNull();
  });

  it('opens a clicked specifier at the top of the file', () => {
    const result = resolveDefinition({
      projectPath: root,
      containingFile: join(root, 'src/App.tsx'),
      specifier: '@/lib/x',
    });
    expect(result).toEqual({ path: join(root, 'src/lib/x.ts'), line: 1, column: 1, endColumn: 1 });
  });
});

describe('resolveModuleSpecifier', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'module-resolver-test-'));
  });

  afterEach(async () => {
    clearResolverCache();
    await rm(projectPath, { recursive: true, force: true });
  });

  it('returns null when specifier is not found (no tsconfig, no file)', () => {
    const containingFile = join(projectPath, 'src', 'index.ts');
    expect(resolveModuleSpecifier(projectPath, containingFile, '@/foo')).toBeNull();
  });

  it('returns null when specifier is absolute', () => {
    const containingFile = join(projectPath, 'src', 'index.ts');
    const absoluteSpecifier = join(projectPath, '..', 'other', 'file');
    expect(resolveModuleSpecifier(projectPath, containingFile, absoluteSpecifier)).toBeNull();
  });

  it('resolves relative asset when file exists', async () => {
    const srcDir = join(projectPath, 'src');
    await mkdir(srcDir, { recursive: true });
    const scssPath = join(srcDir, 'styles.module.scss');
    await writeFile(scssPath, '.x {}');
    const containingFile = join(srcDir, 'app.tsx');
    const result = resolveModuleSpecifier(projectPath, containingFile, './styles.module.scss');
    expect(result).toBe(scssPath);
  });

  it('resolves relative asset with extension probe', async () => {
    const srcDir = join(projectPath, 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'vars.scss'), '$x: 1;');
    const containingFile = join(srcDir, 'app.tsx');
    const result = resolveModuleSpecifier(projectPath, containingFile, './vars');
    expect(result).toMatch(/vars\.scss$/);
  });

  it('uses tsconfig paths when present and file exists', async () => {
    await writeFile(
      join(projectPath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['./src/*'] },
        },
      }),
    );
    const srcDir = join(projectPath, 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'foo.ts'), 'export {}');
    await writeFile(join(srcDir, 'index.ts'), 'import "@/foo";');
    const containingFile = join(projectPath, 'src', 'index.ts');
    const result = resolveModuleSpecifier(projectPath, containingFile, '@/foo');
    expect(result).toMatch(/src[\\/]foo\.ts$/);
  });

  it('returns null for no tsconfig and relative specifier when file does not exist', () => {
    const containingFile = join(projectPath, 'src', 'index.ts');
    expect(resolveModuleSpecifier(projectPath, containingFile, './nonexistent')).toBeNull();
  });

  it('clearResolverCache clears config cache', async () => {
    await writeFile(
      join(projectPath, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.' } }),
    );
    resolveModuleSpecifier(projectPath, join(projectPath, 'a.ts'), './x');
    clearResolverCache();
    // After clear, next resolve will re-read config (no stale cache)
    const result = resolveModuleSpecifier(projectPath, join(projectPath, 'a.ts'), './y');
    expect(result).toBeNull();
  });
});
