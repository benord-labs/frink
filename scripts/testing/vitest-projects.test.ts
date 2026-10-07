import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import vitestConfig, {
  compiledProject,
  reactCompilerBabelPlugin,
  unitProject,
} from '../../vitest.config';

// Guards the split of vitest.config.ts into an uncompiled `unit` project and a `compiled` project
// that runs renderer tests through the React Compiler. A test file that claims to be compiled but
// is not picked up by the compiled project runs uncompiled, or not at all, without any failure.

const ROOT = resolve(__dirname, '../..');
const COMPILED_GLOB = 'src/renderer/**/*.compiled.{test,spec}.{ts,tsx}';
const COMPILED_PATH = /^src\/renderer\/.+\.compiled\.(test|spec)\.tsx?$/;

describe('vitest projects', () => {
  it('declares test files per project and has both projects inherit every other root setting', () => {
    expect(vitestConfig.test?.include).toBeUndefined();
    expect(vitestConfig.test?.setupFiles).toBeUndefined();
    expect(vitestConfig.test?.projects).toEqual([
      { extends: true, ...unitProject },
      { extends: true, ...compiledProject },
    ]);
  });

  it('gives the compiled project only compiled tests and keeps them out of the unit project', () => {
    expect(compiledProject.test.include).toEqual([COMPILED_GLOB]);
    expect(unitProject.test.exclude).toContain(COMPILED_GLOB);
  });

  it('runs the React Compiler in the compiled project only', () => {
    const names = compiledProject.plugins.flat().map((plugin) => plugin.name);

    expect(names).toContain('vite:react-babel');
    expect('plugins' in unitProject).toBe(false);
  });

  it('gives both projects the same setup file', () => {
    expect(compiledProject.test.setupFiles).toEqual(unitProject.test.setupFiles);
    expect(unitProject.test.setupFiles).toEqual(['./vitest.setup.ts']);
  });

  it('has no file named as a compiled test outside the paths the compiled project runs', () => {
    const named = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.compiled.*'],
      { cwd: ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);

    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((file) => !COMPILED_PATH.test(file))).toEqual([]);
  });

  it('compiles tests with the same compiler setting as the app build', () => {
    const appConfig = readFileSync(resolve(ROOT, 'electron.vite.config.ts'), 'utf8');

    expect(reactCompilerBabelPlugin).toEqual(['babel-plugin-react-compiler', { target: '19' }]);
    expect(appConfig).toContain("plugins: [['babel-plugin-react-compiler', { target: '19' }]]");
  });
});
