import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findMissingLiterals, REQUIRED_CLAUDE_BINARY_ENV } from './binary-capabilities.mjs';

const dirs: string[] = [];
function binary(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-cap-'));
  dirs.push(dir);
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('findMissingLiterals', () => {
  it('accepts a binary carrying every env var the auth model needs', () => {
    const file = binary(`junk ${REQUIRED_CLAUDE_BINARY_ENV.join(' junk ')} junk`);
    expect(findMissingLiterals(file, REQUIRED_CLAUDE_BINARY_ENV)).toEqual([]);
  });

  it('names a dropped fd var so the build fails instead of api-key accounts silently 401ing', () => {
    const file = binary('CLAUDE_SECURESTORAGE_CONFIG_DIR CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR');
    expect(findMissingLiterals(file, REQUIRED_CLAUDE_BINARY_ENV)).toEqual([
      'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
    ]);
  });

  it('finds a literal that straddles a chunk boundary', () => {
    const needle = 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR';
    // Chunk size 16: the needle starts at byte 10, so it spans three chunks.
    const file = binary(`${'x'.repeat(10)}${needle}${'y'.repeat(20)}`);
    expect(findMissingLiterals(file, [needle], 16)).toEqual([]);
  });

  it('reports every needle on an empty file', () => {
    expect(findMissingLiterals(binary(''), ['A_VAR', 'B_VAR'])).toEqual(['A_VAR', 'B_VAR']);
  });
});
