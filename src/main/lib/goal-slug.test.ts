import { describe, expect, it } from 'vitest';
import { goalToSlug } from './goal-slug';

describe('goalToSlug', () => {
  it('kebab-cases a normal goal', () => {
    expect(goalToSlug('Build me a dashboard for SEO rankings')).toBe(
      'build-me-a-dashboard-for-seo-rankings',
    );
  });

  it('falls back for empty or whitespace input', () => {
    expect(goalToSlug('')).toBe('my-project');
    expect(goalToSlug('   ')).toBe('my-project');
  });

  it('falls back when all characters are stripped (non-ASCII)', () => {
    expect(goalToSlug('日本語のダッシュボード')).toBe('my-project');
  });

  it('strips diacritics rather than dropping the word', () => {
    expect(goalToSlug('Café résumé')).toBe('cafe-resume');
  });

  it('caps length and trims trailing separators', () => {
    const slug = goalToSlug('a'.repeat(100));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('collapses runs of punctuation/spaces into a single separator', () => {
    expect(goalToSlug('API   ->   Google   Sheets!!!')).toBe('api-google-sheets');
  });

  it('strips a separator left dangling exactly on the length-cap boundary', () => {
    // The cap slice runs BEFORE the trailing-trim. When the 40th char lands on a '-' (a word
    // boundary), the slice keeps it and the trim must remove it — a path the all-'a' cap test
    // never exercises (its boundary falls mid-word). 'abc ' → 'abc-'; 40 chars = ten 'abc-'.
    const slug = goalToSlug('abc '.repeat(11));
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe(Array(10).fill('abc').join('-'));
  });

  it('neutralises path-traversal goals (no separators survive)', () => {
    const slug = goalToSlug('../../etc/passwd');
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('..');
    expect(slug).toBe('etc-passwd');
  });

  it('falls back for goals that are only path characters', () => {
    expect(goalToSlug('../..')).toBe('my-project');
    expect(goalToSlug('/')).toBe('my-project');
  });

  it('avoids Windows reserved device names', () => {
    // "con"/"nul"/"prn" etc. are reserved on Windows — mkdir of that bare name fails.
    expect(goalToSlug('con')).not.toBe('con');
    expect(goalToSlug('NUL')).not.toBe('nul');
    expect(goalToSlug('com1')).not.toBe('com1');
  });
});
