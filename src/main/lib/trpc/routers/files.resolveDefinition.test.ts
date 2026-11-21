import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (v: Buffer) => v.toString(),
  },
}));

describe('filesRouter.resolveDefinition', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'frink-resolve-def-'));
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('returns null when containingFile is outside projectPath', async () => {
    const otherDir = await mkdtemp(join(tmpdir(), 'frink-other-'));
    try {
      const { filesRouter } = await import('./files');
      const caller = filesRouter.createCaller({ getWindow: () => null });
      const result = await caller.resolveDefinition({
        projectPath,
        containingFile: join(otherDir, 'src', 'index.ts'),
        specifier: './foo',
      });
      expect(result).toBeNull();
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it('returns null when containingFile path traverses outside projectPath', async () => {
    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const containingFile = resolve(projectPath, 'src', '..', '..', 'outside', 'file.ts');
    const result = await caller.resolveDefinition({
      projectPath,
      containingFile,
      specifier: './foo',
    });
    expect(result).toBeNull();
  });

  it('returns null when specifier is absolute', async () => {
    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.resolveDefinition({
      projectPath,
      containingFile: join(projectPath, 'src', 'index.ts'),
      specifier: resolve(projectPath, '..', 'other', 'file'),
    });
    expect(result).toBeNull();
  });

  it('returns null when there is no specifier and no cursor offset', async () => {
    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.resolveDefinition({
      projectPath,
      containingFile: join(projectPath, 'src', 'index.ts'),
    });
    expect(result).toBeNull();
  });

  it('returns the declaration position of the import under the cursor', async () => {
    await writeFile(
      join(projectPath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
      }),
    );
    const srcDir = join(projectPath, 'src');
    await mkdir(join(srcDir, 'components'), { recursive: true });
    const fooPath = join(srcDir, 'components', 'Foo.tsx');
    await writeFile(fooPath, 'export const Foo = () => null;', 'utf8');
    const fileContent = "import { Foo } from '@/components/Foo';\nFoo;";
    await writeFile(join(srcDir, 'index.ts'), fileContent, 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.resolveDefinition({
      projectPath,
      containingFile: join(projectPath, 'src', 'index.ts'),
      fileContent,
      offset: fileContent.lastIndexOf('Foo'),
    });

    expect(result).toEqual({ path: fooPath, line: 1, column: 14, endColumn: 17 });
  });

  // zod strips unknown keys and rejects a null it does not allow; either would disable the fix.
  it('reads the unsaved buffer of an open target instead of the file on disk', async () => {
    const srcDir = join(projectPath, 'src');
    await mkdir(srcDir, { recursive: true });
    const fooPath = join(srcDir, 'foo.ts');
    await writeFile(fooPath, 'export const Foo = 1;', 'utf8');
    const fileContent = "import { Foo } from './foo';\nFoo;";

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.resolveDefinition({
      projectPath,
      containingFile: join(srcDir, 'index.ts'),
      fileContent,
      offset: fileContent.lastIndexOf('Foo'),
      openBuffers: { [fooPath]: '\n\nexport const Foo = 1;', [join(srcDir, 'big.ts')]: null },
    });

    expect(result).toMatchObject({ path: fooPath, line: 3, column: 14 });
  });

  it('resolves via specifier when provided (e.g. from quoted string in CSS)', async () => {
    const srcDir = join(projectPath, 'src');
    await mkdir(join(srcDir, 'styles'), { recursive: true });
    await writeFile(join(srcDir, 'styles', 'vars.scss'), '$x: 1;', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.resolveDefinition({
      projectPath,
      containingFile: join(projectPath, 'src', 'app.scss'),
      specifier: './styles/vars',
    });

    expect(result?.path).toMatch(/styles[\\/]vars\.scss$/);
  });
});
