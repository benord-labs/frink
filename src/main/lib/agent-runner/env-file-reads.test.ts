import { describe, expect, it } from 'vitest';
import { envFileAsks, envGlobAsks } from './env-file-reads';

describe('envGlobAsks', () => {
  it('asks for globs that can match a path envFileAsks asks about', () => {
    for (const glob of [
      'config*.env.local',
      '.e*.x',
      '.e*v.x',
      '?*.local',
      '*env.local',
      '*v.local',
      '*.env.local',
      'prod.env.*',
      'api.env.d/*.json',
      '.e*nv.local',
      '*.env',
      '.env*',
      '**/.env',
      '.env.prod*',
      '.e?v',
      '[.]env',
      '[[:punct:]]env',
      '[!a]env',
      '{*.env,!x}',
      '{.env,a}',
      '*.{env,ts}',
      'config/.env',
      '?env',
      '.ENV',
      'Prod.Env',
      'x.env.local',
      '*.env.*',
      '.*',
      '*',
      'src/**',
      'config*',
    ]) {
      expect(envGlobAsks(glob), glob).toBe(true);
    }
  });

  it('stays quiet for globs that name only other files, and for the .env.example template', () => {
    for (const glob of [
      '*.ts',
      '**/*.{ts,tsx}',
      'src/**/*.json',
      '*.md',
      '.env.example',
      '**/.ENV.EXAMPLE',
      '*.env.example',
      '.envrc',
      'env.ts',
      'src/',
      '{*.ts,!x}',
      'docs/!notes.md',
    ]) {
      expect(envGlobAsks(glob), glob).toBe(false);
    }
  });

  it('reads a glob with no wildcard as the path it names, in a folder too', () => {
    expect(envFileAsks('config/.env')).toBe(true);
    for (const glob of ['config/.env', 'config/{.env,a}', 'a/b/.Env.Local']) {
      expect(envGlobAsks(glob), glob).toBe(true);
    }
  });

  it('does not count a .env. in the middle of a path when one * covers all of its .env', () => {
    expect(envFileAsks('.env.local')).toBe(true);
    expect(envFileAsks('x.env.local')).toBe(true);
    for (const glob of ['*.local', 'x*.local', '*.ts', '**/*.json']) {
      expect(envGlobAsks(glob), glob).toBe(false);
    }
  });

  it('asks for extended groups, classes inside braces and globs too large to check', () => {
    for (const glob of [
      '@(a|b).ts',
      'a(b).ts',
      '{[.,x]env,y}',
      '{a,b}'.repeat(7),
      `${'a'.repeat(600)}.ts`,
    ]) {
      expect(envGlobAsks(glob), glob).toBe(true);
    }
  });
});
