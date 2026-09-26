import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTsConfigPaths } from './tsconfig-resolver';

describe('resolveTsConfigPaths', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'tsconfig-test-'));
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('returns empty when no tsconfig.json exists', async () => {
    const result = await resolveTsConfigPaths(projectPath);
    expect(result).toEqual({});
  });

  it('reads paths and baseUrl from tsconfig.json', async () => {
    await writeFile(
      join(projectPath, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['./src/*'],
            '@components/*': ['./src/components/*'],
          },
        },
      }),
    );

    const result = await resolveTsConfigPaths(projectPath);
    expect(result.baseUrl).toBe(projectPath);
    expect(result.paths).toEqual({
      '@/*': ['./src/*'],
      '@components/*': ['./src/components/*'],
    });
  });

  it('resolves extends chain', async () => {
    await writeFile(
      join(projectPath, 'tsconfig.base.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['./src/*'] },
          strict: true,
        },
      }),
    );

    await writeFile(
      join(projectPath, 'tsconfig.json'),
      JSON.stringify({
        extends: './tsconfig.base.json',
        compilerOptions: {
          paths: { '@utils/*': ['./src/utils/*'] },
        },
      }),
    );

    const result = await resolveTsConfigPaths(projectPath);
    expect(result.baseUrl).toBe(projectPath);
    // Child paths override parent paths
    expect(result.paths).toEqual({
      '@utils/*': ['./src/utils/*'],
    });
  });

  it('handles tsconfig with comments', async () => {
    await writeFile(
      join(projectPath, 'tsconfig.json'),
      `{
        // This is a comment
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@/*": ["./src/*"] // inline comment
          }
        }
      }`,
    );

    const result = await resolveTsConfigPaths(projectPath);
    expect(result.baseUrl).toBe(projectPath);
    expect(result.paths).toEqual({
      '@/*': ['./src/*'],
    });
  });

  it('handles trailing commas in JSON', async () => {
    await writeFile(
      join(projectPath, 'tsconfig.json'),
      `{
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@/*": ["./src/*"],
          },
        },
      }`,
    );

    const result = await resolveTsConfigPaths(projectPath);
    expect(result.baseUrl).toBe(projectPath);
  });

  it('falls back to tsconfig.app.json', async () => {
    await writeFile(
      join(projectPath, 'tsconfig.app.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '~/*': ['./app/*'] },
        },
      }),
    );

    const result = await resolveTsConfigPaths(projectPath);
    expect(result.paths).toEqual({
      '~/*': ['./app/*'],
    });
  });

  it('returns empty paths when no compilerOptions', async () => {
    await writeFile(join(projectPath, 'tsconfig.json'), JSON.stringify({}));

    const result = await resolveTsConfigPaths(projectPath);
    expect(result).toEqual({});
  });

  it('parses tsconfig files with $schema URLs', async () => {
    await writeFile(
      join(projectPath, 'tsconfig.json'),
      JSON.stringify({
        $schema: 'https://json.schemastore.org/tsconfig',
        compilerOptions: {
          paths: {
            '@/*': ['./src/*'],
          },
        },
      }),
    );

    const result = await resolveTsConfigPaths(projectPath);
    expect(result.paths).toEqual({
      '@/*': ['./src/*'],
    });
  });
});
