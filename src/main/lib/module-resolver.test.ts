import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearResolverCache,
  findModuleSpecifierForSymbol,
  resolveModuleSpecifier,
} from './module-resolver';

describe('findModuleSpecifierForSymbol', () => {
  it('returns specifier for named import', () => {
    const content = `import { Foo } from '@/components/Foo';`;
    expect(findModuleSpecifierForSymbol(content, 'Foo')).toBe('@/components/Foo');
  });

  it('returns specifier for default import', () => {
    const content = `import styles from './styles.module.scss';`;
    expect(findModuleSpecifierForSymbol(content, 'styles')).toBe('./styles.module.scss');
  });

  it('returns specifier for namespace import', () => {
    const content = `import * as utils from '@/utils';`;
    expect(findModuleSpecifierForSymbol(content, 'utils')).toBe('@/utils');
  });

  it('returns specifier for re-export', () => {
    const content = `export { CompiledAnalyticsMethods } from '@/providers/analytics';`;
    expect(findModuleSpecifierForSymbol(content, 'CompiledAnalyticsMethods')).toBe(
      '@/providers/analytics',
    );
  });

  it('returns null for symbol not from an import', () => {
    const content = `const local = 1; type T = number;`;
    expect(findModuleSpecifierForSymbol(content, 'local')).toBeNull();
    expect(findModuleSpecifierForSymbol(content, 'T')).toBeNull();
  });

  it('returns null when symbol name is not in any import', () => {
    const content = `import { Foo } from '@/foo'; const x = 1;`;
    expect(findModuleSpecifierForSymbol(content, 'x')).toBeNull();
    expect(findModuleSpecifierForSymbol(content, 'Bar')).toBeNull();
  });

  it('returns first matching import when symbol appears in multiple', () => {
    const content = `import { a } from './first'; import { a as b } from './second';`;
    expect(findModuleSpecifierForSymbol(content, 'a')).toBe('./first');
    expect(findModuleSpecifierForSymbol(content, 'b')).toBe('./second');
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
