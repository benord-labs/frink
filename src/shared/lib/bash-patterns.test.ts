import { describe, expect, it } from 'vitest';
import { getPatternDescription, TRAILING_WILDCARD_REGEX, truncatePattern } from './bash-patterns';

describe('bash-patterns', () => {
  describe('TRAILING_WILDCARD_REGEX', () => {
    it('matches trailing " *"', () => {
      expect(TRAILING_WILDCARD_REGEX.test('git push *')).toBe(true);
      expect(TRAILING_WILDCARD_REGEX.test('find /path *')).toBe(true);
      expect(TRAILING_WILDCARD_REGEX.test('npm run')).toBe(false);
    });
  });

  describe('getPatternDescription', () => {
    it('single word pattern returns "All X commands"', () => {
      expect(getPatternDescription('find *')).toBe('All find commands');
    });

    it('simple subcommand returns "All X Y commands"', () => {
      expect(getPatternDescription('git push *')).toBe('All git push commands');
    });

    it('path-based pattern returns "X in this location"', () => {
      expect(getPatternDescription('find /path *')).toBe('find in this location');
    });
  });

  describe('truncatePattern', () => {
    it('returns as-is when under maxLen', () => {
      expect(truncatePattern('short', 40)).toBe('short');
    });

    it('truncates with ellipsis when over maxLen', () => {
      const long = 'a'.repeat(50);
      expect(truncatePattern(long, 40)).toBe(`${'a'.repeat(40)}...`);
    });
  });
});
