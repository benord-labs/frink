import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeForMentionToken } from './mention-token-codec';
import { parseMention } from './parse-mention';

// A payload that does not decode logs a warning by design; keep it out of the test log.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseMention', () => {
  describe('file and folder tokens', () => {
    it('reads a dotfile at the repository root', () => {
      expect(parseMention('file:local:.oxlintrc.json')).toStrictEqual({
        id: 'file:local:.oxlintrc.json',
        label: '.oxlintrc.json',
        path: '.oxlintrc.json',
        repository: 'local',
        type: 'file',
      });
    });

    it('keeps the colons that belong to a file path', () => {
      expect(parseMention('file:owner/repo:docs/10:30 notes/plan.md')).toStrictEqual({
        id: 'file:owner/repo:docs/10:30 notes/plan.md',
        label: 'plan.md',
        path: 'docs/10:30 notes/plan.md',
        repository: 'owner/repo',
        type: 'file',
      });
    });

    it('labels a folder with its last path segment', () => {
      expect(parseMention('folder:local:src/x')).toStrictEqual({
        id: 'folder:local:src/x',
        label: 'x',
        path: 'src/x',
        repository: 'local',
        type: 'folder',
      });
    });

    it('labels a path ending in a slash with the whole path', () => {
      expect(parseMention('folder:local:src/x/')).toStrictEqual({
        id: 'folder:local:src/x/',
        label: 'src/x/',
        path: 'src/x/',
        repository: 'local',
        type: 'folder',
      });
    });

    it.each([
      ['file', 'src\\components\\Button.tsx', 'Button.tsx'],
      ['folder', 'src\\lib', 'lib'],
      ['folder', 'src\\lib\\', 'src\\lib\\'],
    ] as const)('labels a Windows %s path %j as %j', (type, path, label) => {
      expect(parseMention(`${type}:local:${path}`)).toStrictEqual({
        id: `${type}:local:${path}`,
        label,
        path,
        repository: 'local',
        type,
      });
    });

    it('accepts an empty repository and path once both separators are present', () => {
      expect(parseMention('file::')).toStrictEqual({
        id: 'file::',
        label: '',
        path: '',
        repository: '',
        type: 'file',
      });
    });

    it.each(['file:README.md', 'file:', 'folder:src', 'folder:'])(
      'rejects %j, which has no repository separator',
      (id) => {
        expect(parseMention(id)).toBeNull();
      },
    );
  });

  describe('skill and agent tokens', () => {
    it('labels a skill with everything after the prefix, colons included', () => {
      expect(parseMention('skill:vercel:deploy')).toStrictEqual({
        id: 'skill:vercel:deploy',
        label: 'vercel:deploy',
        path: '',
        repository: '',
        type: 'skill',
      });
    });

    it('labels an agent with its name', () => {
      expect(parseMention('agent:feature-critique')).toStrictEqual({
        id: 'agent:feature-critique',
        label: 'feature-critique',
        path: '',
        repository: '',
        type: 'agent',
      });
    });

    it('returns an empty label rather than null when the name is missing', () => {
      expect(parseMention('skill:')).toStrictEqual({
        id: 'skill:',
        label: '',
        path: '',
        repository: '',
        type: 'skill',
      });
      expect(parseMention('agent:')).toStrictEqual({
        id: 'agent:',
        label: '',
        path: '',
        repository: '',
        type: 'agent',
      });
    });
  });

  describe('tool tokens', () => {
    it('turns the tool part of an MCP tool name into a title', () => {
      expect(parseMention('tool:mcp__server__some_tool')).toStrictEqual({
        id: 'tool:mcp__server__some_tool',
        label: 'Some Tool',
        path: 'mcp__server__some_tool',
        repository: '',
        type: 'tool',
      });
    });

    it('keeps a double underscore inside the tool part as two spaces', () => {
      expect(parseMention('tool:mcp__server__get__design_file')).toStrictEqual({
        id: 'tool:mcp__server__get__design_file',
        label: 'Get  Design File',
        path: 'mcp__server__get__design_file',
        repository: '',
        type: 'tool',
      });
    });

    it.each([
      ['tool:plain_tool', 'Plain Tool', 'plain_tool'],
      ['tool:mcp__server', 'Mcp  Server', 'mcp__server'],
      ['tool:', '', ''],
    ])('titles the whole name of %j, which has no server and tool parts', (id, label, path) => {
      expect(parseMention(id)).toStrictEqual({ id, label, path, repository: '', type: 'tool' });
    });
  });

  describe('quote tokens', () => {
    it('uses the text as both label and full text when there is no base64 part', () => {
      expect(parseMention('quote:hello world')).toStrictEqual({
        id: 'quote:hello world',
        label: 'hello world',
        path: '',
        repository: '',
        type: 'quote',
        fullText: 'hello world',
      });
    });

    it('shortens a label longer than 50 characters when there is no base64 part', () => {
      const fifty = 'a'.repeat(50);
      expect(parseMention(`quote:${fifty}`)?.label).toBe(fifty);
      expect(parseMention(`quote:${fifty}b`)).toStrictEqual({
        id: `quote:${fifty}b`,
        label: `${fifty}...`,
        path: '',
        repository: '',
        type: 'quote',
        fullText: `${fifty}b`,
      });
    });

    it('decodes the base64 part into the full text', () => {
      const full = 'Use strict mode: always.\nNo exceptions — ever.';
      const id = `quote:Use strict mode:${encodeForMentionToken(full)}`;
      expect(parseMention(id)).toStrictEqual({
        id,
        label: 'Use strict mode',
        path: '',
        repository: '',
        type: 'quote',
        fullText: full,
      });
    });

    it.each(['quote:preview:not-valid!!!', 'quote:preview:'])(
      'leaves the full text empty for %j, whose base64 part does not decode',
      (id) => {
        expect(parseMention(id)).toStrictEqual({
          id,
          label: 'preview',
          path: '',
          repository: '',
          type: 'quote',
          fullText: '',
        });
      },
    );
  });

  describe('diff tokens', () => {
    it('reads the file, a non-zero line and the decoded text', () => {
      const full = 'const a = 1;\nconst b = 2;';
      const id = `diff:src/renderer/app.tsx:42:const a = 1;:${encodeForMentionToken(full)}`;
      expect(parseMention(id)).toStrictEqual({
        id,
        label: 'app.tsx:42',
        path: 'src/renderer/app.tsx',
        repository: '',
        type: 'diff',
        fullText: full,
        lineNumber: 42,
      });
    });

    it('treats line 0 as no line', () => {
      const id = `diff:src/renderer/app.tsx:0:preview:${encodeForMentionToken('whole hunk')}`;
      expect(parseMention(id)).toStrictEqual({
        id,
        label: 'app.tsx',
        path: 'src/renderer/app.tsx',
        repository: '',
        type: 'diff',
        fullText: 'whole hunk',
        lineNumber: undefined,
      });
    });

    it.each([
      ['12', 'b.ts:12', 12],
      ['0', 'b.ts', undefined],
    ])('labels a Windows path on line %s by its file name', (line, label, lineNumber) => {
      const id = `diff:src\\a\\b.ts:${line}:preview`;
      expect(parseMention(id)).toStrictEqual({
        id,
        label,
        path: 'src\\a\\b.ts',
        repository: '',
        type: 'diff',
        fullText: 'preview',
        lineNumber,
      });
    });

    it('treats a line that is not a number as no line', () => {
      expect(parseMention('diff:README.md:abc:preview')).toStrictEqual({
        id: 'diff:README.md:abc:preview',
        label: 'README.md',
        path: 'README.md',
        repository: '',
        type: 'diff',
        fullText: 'preview',
        lineNumber: undefined,
      });
    });

    it('hands a base64 part containing colons to the decoder whole, which rejects it', () => {
      expect(parseMention('diff:src/a.ts:7:preview:QQ==:QQ==')).toStrictEqual({
        id: 'diff:src/a.ts:7:preview:QQ==:QQ==',
        label: 'a.ts:7',
        path: 'src/a.ts',
        repository: '',
        type: 'diff',
        fullText: '',
        lineNumber: 7,
      });
    });

    it.each(['diff:src/a.ts:7:preview', 'diff:src/a.ts:7:preview:'])(
      'falls back to the preview for %j, which has no base64 part',
      (id) => {
        expect(parseMention(id)).toStrictEqual({
          id,
          label: 'a.ts:7',
          path: 'src/a.ts',
          repository: '',
          type: 'diff',
          fullText: 'preview',
          lineNumber: 7,
        });
      },
    );

    it.each(['diff:src/a.ts:7', 'diff:src/a.ts', 'diff:'])(
      'rejects %j, which has no preview part',
      (id) => {
        expect(parseMention(id)).toBeNull();
      },
    );
  });

  describe('code tokens', () => {
    it('decodes a URI-encoded file name and keeps the colons of the preview out of it', () => {
      const full = 'const a: number = 1;\nconst b: number = 2;';
      const id = `code:src%2Fmy%20file.ts:13-26:const a: number = 1;:${encodeForMentionToken(full)}`;
      expect(parseMention(id)).toStrictEqual({
        id,
        label: 'src/my file.ts L13-26',
        path: 'src/my file.ts',
        repository: '',
        type: 'code',
        fullText: full,
        lineRange: '13-26',
      });
    });

    it('keeps a file name that is not valid URI encoding as written', () => {
      const id = `code:100%.ts:1-2:preview:${encodeForMentionToken('x')}`;
      expect(parseMention(id)).toStrictEqual({
        id,
        label: '100%.ts L1-2',
        path: '100%.ts',
        repository: '',
        type: 'code',
        fullText: 'x',
        lineRange: '1-2',
      });
    });

    it('falls back to a preview containing colons when the base64 part is empty', () => {
      expect(parseMention('code:a.ts:1-2:const a: number:')).toStrictEqual({
        id: 'code:a.ts:1-2:const a: number:',
        label: 'a.ts L1-2',
        path: 'a.ts',
        repository: '',
        type: 'code',
        fullText: 'const a: number',
        lineRange: '1-2',
      });
    });

    it('leaves the full text empty when the base64 part does not decode', () => {
      expect(parseMention('code:a.ts:1-2:preview:not-valid!!!')).toStrictEqual({
        id: 'code:a.ts:1-2:preview:not-valid!!!',
        label: 'a.ts L1-2',
        path: 'a.ts',
        repository: '',
        type: 'code',
        fullText: '',
        lineRange: '1-2',
      });
    });

    it.each(['code:a.ts:1-2:preview', 'code:a.ts:1-2', 'code:'])(
      'rejects %j, which has fewer than four parts',
      (id) => {
        expect(parseMention(id)).toBeNull();
      },
    );
  });

  describe('pasted tokens', () => {
    it('reads the size, the preview and a path containing colons', () => {
      const id = 'pasted:1234:first line of paste|/Users/me/pasted/2026-10-12T10:30:00.txt';
      expect(parseMention(id)).toStrictEqual({
        id,
        label: 'first line of paste',
        path: '/Users/me/pasted/2026-10-12T10:30:00.txt',
        repository: '',
        type: 'pasted',
        fullText: 'first line of paste',
        size: 1234,
      });
    });

    it('splits on the last pipe, so the preview keeps its own pipes and colons', () => {
      expect(parseMention('pasted:10:a|b: c|/tmp/x.txt')).toStrictEqual({
        id: 'pasted:10:a|b: c|/tmp/x.txt',
        label: 'a|b: c',
        path: '/tmp/x.txt',
        repository: '',
        type: 'pasted',
        fullText: 'a|b: c',
        size: 10,
      });
    });

    it.each([
      ['pasted::preview|/tmp/x.txt', 0],
      ['pasted:abc:preview|/tmp/x.txt', Number.NaN],
    ])('reads the size of %j as %d', (id, size) => {
      expect(parseMention(id)).toStrictEqual({
        id,
        label: 'preview',
        path: '/tmp/x.txt',
        repository: '',
        type: 'pasted',
        fullText: 'preview',
        size,
      });
    });

    it.each(['pasted:10:preview', 'pasted:10|/tmp/x.txt', 'pasted:'])(
      'rejects %j, which lacks the pipe or the size separator',
      (id) => {
        expect(parseMention(id)).toBeNull();
      },
    );
  });

  describe('unknown kinds', () => {
    it.each([
      'image:local:a.png',
      'briefing:flow-1:TQ==:Qg==',
      'FILE:local:a.ts',
      ' file:local:a.ts',
      'file',
      '',
    ])('rejects %j', (id) => {
      expect(parseMention(id)).toBeNull();
    });
  });
});
