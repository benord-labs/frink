import { describe, expect, it } from 'vitest';
import { containsMarkdown } from '@/lib/utils/contains-markdown';

describe('containsMarkdown', () => {
  describe('strong signals (single match)', () => {
    it.each([
      ['**Project**: frink', 'bold'],
      ['__bold__ text', 'underscore bold'],
      ['some ~~strike~~ here', 'strikethrough'],
      ['run `bun test` now', 'inline code'],
      ['```\ncode\n```', 'fenced code'],
      ['# Heading', 'atx heading'],
      ['### Sub heading', 'deep heading'],
      ['see [the docs](https://x.com)', 'link'],
    ])('detects %s (%s)', (input) => {
      expect(containsMarkdown(input)).toBe(true);
    });
  });

  describe('weak signals need corroboration', () => {
    it('detects a multi-item ordered list', () => {
      expect(containsMarkdown('1. first\n2. second\n3. third')).toBe(true);
    });

    it('detects a multi-item unordered list', () => {
      expect(containsMarkdown('- one\n- two')).toBe(true);
    });

    it('detects a blockquote pair', () => {
      expect(containsMarkdown('> line one\n> line two')).toBe(true);
    });
  });

  describe('OS line endings (Windows CRLF)', () => {
    // Detection splits on \n and line-anchors weak patterns; a trailing \r must
    // not break list/heading/fence detection on Windows-authored content.
    it('detects a CRLF unordered list', () => {
      expect(containsMarkdown('- one\r\n- two\r\n')).toBe(true);
    });

    it('detects a CRLF ordered list', () => {
      expect(containsMarkdown('1. first\r\n2. second\r\n')).toBe(true);
    });

    it('detects a CRLF ATX heading not on the first line', () => {
      expect(containsMarkdown('intro\r\n## Heading\r\nbody')).toBe(true);
    });

    it('detects a CRLF fenced code block', () => {
      expect(containsMarkdown('text\r\n```\r\ncode\r\n```')).toBe(true);
    });

    it('keeps a single CRLF list line below the corroboration threshold', () => {
      expect(containsMarkdown('- only one\r\n')).toBe(false);
    });
  });

  describe('negatives (toggle must NOT appear)', () => {
    it.each([
      ['1. buy milk', 'lone ordered-list-like sentence'],
      ['2 * 3 = 6', 'multiplication'],
      ['a | b', 'single pipe'],
      ['Please put a plan together to fix the request.', 'plain prose'],
      ['Project: frink\n\nDo the thing.', 'multi-line plain prose'],
      ['', 'empty string'],
      ['- just one bullet', 'single weak line'],
    ])('returns false for %s (%s)', (input) => {
      expect(containsMarkdown(input)).toBe(false);
    });
  });

  describe('mention tokens', () => {
    it.each([
      '@[file:local:.oxlintrc.json] how are you?',
      '@[file:local:src/__tests__/foo.test.ts] fix this',
      'use @[tool:mcp__figma__get_design] here',
    ])('does not read a bare token as markdown: %s', (input) => {
      expect(containsMarkdown(input)).toBe(false);
    });

    it('still detects markdown next to a token', () => {
      expect(containsMarkdown('@[file:local:a.ts] fix the **thing**')).toBe(true);
    });

    it.each([
      'Review these:\n- @[file:local:src/a.ts]\n- @[file:local:src/b.ts]',
      '1. @[file:local:a.ts]\n2. @[file:local:b.ts]',
      '**@[file:local:a.ts]** is the culprit',
    ])('detects markdown whose only content is tokens: %s', (input) => {
      expect(containsMarkdown(input)).toBe(true);
    });
  });
});
