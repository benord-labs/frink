import { describe, expect, it } from 'vitest';
import { cleanGeneratedName, isMultiWord, tidyToTitle } from './clean-name';

describe('cleanGeneratedName', () => {
  it.each([
    [
      'first quoted candidate when several are returned',
      '"Hello!" or "Welcome!" or "Hi!"',
      'Hello!',
    ],
    [
      'apostrophe inside a double-quoted title',
      '"Don\'t fix the auth bug"',
      "Don't fix the auth bug",
    ],
    ['unbalanced leading quote', '"Fix auth race', 'Fix auth race'],
    ['unbalanced trailing quote', 'Fix auth race"', 'Fix auth race'],
    ['single-quote wrapped title', "'Fix auth race'", 'Fix auth race'],
    ['"Title:" prefix with wrapping quotes', 'Title: "Fix auth race"', 'Fix auth race'],
    [
      'first line only on CRLF output',
      '"Fix auth race"\r\nHere are some alternatives:',
      'Fix auth race',
    ],
    ['leading list and emoji markers', '1. 🚀 Fix auth race', 'Fix auth race'],
    ['leading blank lines', '\n\nFix auth race', 'Fix auth race'],
    ['empty string', '', null],
    ['whitespace-only input', '   \n  ', null],
  ])('handles %s', (_desc, input, expected) => {
    expect(cleanGeneratedName(input)).toBe(expected);
  });
});

describe('isMultiWord', () => {
  it.each([
    ['Refactor', false], // single word
    ['Fix auth bug', true], // two+ words
    ['auth-bug', false], // hyphenated single token = one word
    ['  Solo  ', false], // surrounding whitespace ignored
    ['  two words  ', true],
    ['', false], // empty
  ])('%j → %s', (input, expected) => {
    expect(isMultiWord(input)).toBe(expected);
  });
});

describe('tidyToTitle', () => {
  it.each([
    ['please refactor the auth module', 'Please Refactor The Auth Module'],
    ['one two three four five six seven', 'One Two Three Four Five'], // caps at 5 words
    ['fix the API timeout', 'Fix The API Timeout'], // acronym casing preserved (first-letter only)
    ['hello', 'Hello'], // one-word message stays one word (inherent edge)
    ['   ', ''], // empty message → '' so callers fall back further
    ['fix\r\nthe\tlogin bug', 'Fix The Login Bug'], // cross-OS whitespace (tabs/CRLF)
  ])('%j → %j', (input, expected) => {
    expect(tidyToTitle(input)).toBe(expected);
  });

  it('never exceeds the 50-char cap', () => {
    expect(
      tidyToTitle('supercalifragilistic expialidocious antidisestablishmentarianism').length,
    ).toBeLessThanOrEqual(50);
  });
});
