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

  it('returns null when no specifier and no symbol/fileContent', async () => {
    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.resolveDefinition({
      projectPath,
      containingFile: join(projectPath, 'src', 'index.ts'),
    });
    expect(result).toBeNull();
  });

  it('resolves via symbol name when TS content has matching import', async () => {
    await writeFile(
      join(projectPath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
      }),
    );
    const srcDir = join(projectPath, 'src');
    await mkdir(join(srcDir, 'components'), { recursive: true });
    await writeFile(
      join(srcDir, 'components', 'Foo.tsx'),
      'export const Foo = () => null;',
      'utf8',
    );
    await writeFile(join(srcDir, 'index.ts'), 'import "@/components/Foo";', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.resolveDefinition({
      projectPath,
      containingFile: join(projectPath, 'src', 'index.ts'),
      symbolName: 'Foo',
      fileContent: "import { Foo } from '@/components/Foo';",
    });

    expect(result).toMatch(/src[\\/]components[\\/]Foo\.tsx$/);
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

    expect(result).toMatch(/styles[\\/]vars\.scss$/);
  });
});
