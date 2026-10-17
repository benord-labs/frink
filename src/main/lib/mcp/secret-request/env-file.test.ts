import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasEnvKey,
  quoteEnvValue,
  SecretRequestError,
  upsertEnvLine,
  writeEnvFileAtomic,
} from './env-file';

describe('quoteEnvValue', () => {
  it('leaves a plain token bare', () => {
    expect(quoteEnvValue('sk_live_AbC-12.3/+=')).toBe('sk_live_AbC-12.3/+=');
  });

  it('picks a quote that no dotenv loader rewrites', () => {
    expect(quoteEnvValue('has space $HOME')).toBe("'has space $HOME'");
    // Bare, everything from `#` on would load as a comment and the key would come back cut short.
    expect(quoteEnvValue('abc#123')).toBe("'abc#123'");
    expect(quoteEnvValue("it's")).toBe(`"it's"`);
  });

  it('refuses values that cannot be written on one safe line', () => {
    expect(() => quoteEnvValue('')).toThrow(SecretRequestError);
    expect(() => quoteEnvValue('a\nb')).toThrow(SecretRequestError);
    expect(() => quoteEnvValue('x'.repeat(16_385))).toThrow(SecretRequestError);
  });

  // python-dotenv decodes `\\` and `\'` inside single quotes, Node's dotenv does not, and only Node's
  // reads backticks: no quoting round-trips these on both, so they must go in by hand.
  it.each([
    ['a backslash', 'ab\\cd'],
    ['a Windows-style path', 'C:\\keys\\prod'],
    ['an apostrophe and a double quote', `it's "x"`],
    ['an apostrophe and a dollar', "it's $5"],
    ['an apostrophe, a double quote and a dollar', `a'b"c$d`],
  ])('refuses a value with %s rather than save a different secret', (_label, value) => {
    expect(() => quoteEnvValue(value)).toThrow(SecretRequestError);
  });
});

describe('upsertEnvLine', () => {
  it('creates a file with a trailing newline', () => {
    expect(upsertEnvLine('', 'API_KEY', 'abc')).toBe('API_KEY=abc\n');
  });

  it('appends before the trailing newline and keeps the other lines', () => {
    expect(upsertEnvLine('# keys\nA=1\n', 'API_KEY', 'abc')).toBe('# keys\nA=1\nAPI_KEY=abc\n');
    expect(upsertEnvLine('A=1', 'API_KEY', 'abc')).toBe('A=1\nAPI_KEY=abc\n');
  });

  it('replaces the first line for the key, keeps export, and drops later duplicates', () => {
    const before = 'export API_KEY = old\nB=2\nAPI_KEY=older\n';
    expect(upsertEnvLine(before, 'API_KEY', 'new')).toBe('export API_KEY=new\nB=2\n');
  });

  it('leaves a commented-out line for the key alone instead of uncommenting it', () => {
    expect(upsertEnvLine('# API_KEY=example\n', 'API_KEY', 'y')).toBe(
      '# API_KEY=example\nAPI_KEY=y\n',
    );
  });

  it('never touches a key that only shares a prefix', () => {
    expect(upsertEnvLine('API_KEY_2=x\n', 'API_KEY', 'y')).toBe('API_KEY_2=x\nAPI_KEY=y\n');
  });

  // Split on CRLF alone, an LF-only line hides inside its neighbour and its duplicate survives.
  it('drops a later duplicate in a file with mixed line endings', () => {
    expect(upsertEnvLine('API_KEY=stale\r\nB=1\nAPI_KEY=later\r\n', 'API_KEY', 'new')).toBe(
      'API_KEY=new\r\nB=1\r\n',
    );
  });

  it('keeps CRLF line endings', () => {
    expect(upsertEnvLine('A=1\r\nAPI_KEY=old\r\n', 'API_KEY', 'new')).toBe(
      'A=1\r\nAPI_KEY=new\r\n',
    );
  });

  it('refuses to edit a value that spans several lines', () => {
    expect(() => upsertEnvLine('CERT="-----BEGIN\nabc\n-----END"\n', 'CERT', 'x')).toThrow(
      'CERT spans several lines in this file. Edit it by hand.',
    );
  });

  it("never rewrites a line inside another key's multi-line value", () => {
    const cert = 'CERT="-----BEGIN\nAPI_KEY=looks-like-a-key\n-----END"\n';

    expect(upsertEnvLine(cert, 'API_KEY', 'new')).toBe(`${cert}API_KEY=new\n`);
    expect(hasEnvKey(cert, 'API_KEY')).toBe(false);
  });

  // Both Node's dotenv and python-dotenv treat `\\"` as an escaped quote, so CERT spans three lines.
  it('reads past an escaped quote when finding where a multi-line value ends', () => {
    const cert = 'CERT="a\\"b\nAPI_KEY=old\nEND"\n';

    expect(upsertEnvLine(cert, 'API_KEY', 'new')).toBe(`${cert}API_KEY=new\n`);
    expect(hasEnvKey(cert, 'API_KEY')).toBe(false);
    expect(hasEnvKey('CERT="a\\"b\nx\\" still open\nEND"\nAPI_KEY=1', 'API_KEY')).toBe(true);
  });

  // Node's dotenv reads a quote that never closes as a one-line value, so API_KEY=old is live and
  // must be the line replaced, not left behind with the old secret.
  it('replaces a key that follows a quote that never closes', () => {
    const next = upsertEnvLine('OTHER="abc\nAPI_KEY=old\n', 'API_KEY', 'new');

    expect(next).toBe('OTHER="abc\nAPI_KEY=new\n');
    expect(parseDotenv(next)).toEqual({ OTHER: '"abc', API_KEY: 'new' });
  });

  it('appends a key that Node dotenv still reads after a quote that never closes', () => {
    const next = upsertEnvLine('NOTE="say hi\n', 'STRIPE_KEY', "ab'cd");

    expect(parseDotenv(next)).toEqual({ NOTE: '"say hi', STRIPE_KEY: "ab'cd" });
  });

  // dotenv also reads `KEY: value`, a form the editor does not rewrite: the re-read after the edit
  // still finds the old line, so the save is refused instead of leaving the old secret behind.
  it('refuses any edit that dotenv would not read back as just the new value', () => {
    expect(() => upsertEnvLine('API_KEY: old\n', 'API_KEY', 'new')).toThrow(
      'Frink could not add API_KEY to this file safely. Add it by hand.',
    );
  });

  it('says a key is set exactly when Node dotenv reads it', () => {
    expect(hasEnvKey('OTHER="abc\nAPI_KEY=old\n', 'API_KEY')).toBe(true);
  });

  it('reports whether a key is already set', () => {
    expect(hasEnvKey('A=1\r\nexport API_KEY=x', 'API_KEY')).toBe(true);
    expect(hasEnvKey('API_KEY_2=x', 'API_KEY')).toBe(false);
  });
});

describe('writeEnvFileAtomic', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secret-env-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates a new file readable only by the user', async () => {
    const target = path.join(dir, '.env');
    await writeEnvFileAtomic(target, 'A=1\n');

    expect(await fs.readFile(target, 'utf8')).toBe('A=1\n');
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  it('keeps the mode of an existing file', async () => {
    const target = path.join(dir, '.env');
    await fs.writeFile(target, 'A=1\n', { mode: 0o640 });
    await fs.chmod(target, 0o640);

    await writeEnvFileAtomic(target, 'A=2\n');

    expect(await fs.readFile(target, 'utf8')).toBe('A=2\n');
    expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
  });

  it('leaves the original untouched and no temp file behind when the rename fails', async () => {
    const target = path.join(dir, '.env');
    await fs.writeFile(target, 'A=1\n');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));

    await expect(writeEnvFileAtomic(target, 'A=2\n')).rejects.toThrow('disk full');

    expect(await fs.readFile(target, 'utf8')).toBe('A=1\n');
    expect(await fs.readdir(dir)).toEqual(['.env']);
  });
});
