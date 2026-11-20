import { describe, expect, it } from 'vitest';
import { type OpenFile, openFilesAtom } from '@/lib/code-editor/state';
import { appStore } from '@/lib/jotai-store';
import {
  collectOpenBuffers,
  openTabBuffers,
  type QueryDefinition,
  resolveAliasDefinition,
} from './resolve-alias-definition';

const SOURCE = 'import { Foo } from "@/foo";\nFoo;';
const model = {
  uri: { path: '/repo/src/a.ts' },
  getLanguageId: () => 'typescript',
  getLineContent: () => 'Foo;',
  getValue: () => SOURCE,
  getOffsetAt: () => SOURCE.lastIndexOf('Foo'),
};
const position = { lineNumber: 2, column: 1 };
const reply = { path: '/repo/src/foo.ts', line: 3, column: 14, endColumn: 17 };

describe('resolveAliasDefinition', () => {
  it('sends the cursor offset and returns the declaration range from the reply', async () => {
    const sent: Parameters<QueryDefinition>[0][] = [];
    const query: QueryDefinition = async (input) => {
      sent.push(input);
      return reply;
    };

    const result = await resolveAliasDefinition(
      model,
      position,
      { isCancellationRequested: false },
      '/repo',
      query,
    );

    expect(sent).toEqual([
      {
        projectPath: '/repo',
        containingFile: '/repo/src/a.ts',
        fileContent: SOURCE,
        offset: SOURCE.lastIndexOf('Foo'),
        specifier: undefined,
      },
    ]);
    expect(result).toEqual({
      path: '/repo/src/foo.ts',
      range: { startLineNumber: 3, startColumn: 14, endLineNumber: 3, endColumn: 17 },
    });
  });

  it('sends nothing when the request is already cancelled', async () => {
    let calls = 0;
    const result = await resolveAliasDefinition(
      model,
      position,
      { isCancellationRequested: true },
      '/repo',
      async () => {
        calls += 1;
        return reply;
      },
    );

    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  // Monaco's Uri.path is already decoded, so a second decode throws on '%' or rewrites '%20'.
  it.each(['/repo/src/100%.ts', '/repo/src/a%20b.ts'])(
    'sends the model path %s unchanged',
    async (path) => {
      const sent: string[] = [];
      await resolveAliasDefinition(
        { ...model, uri: { path } },
        position,
        { isCancellationRequested: false },
        '/repo',
        async (input) => {
          sent.push(input.containingFile);
          return reply;
        },
      );

      expect(sent).toEqual([path]);
    },
  );

  it('drops a reply that arrives after the request was cancelled', async () => {
    const token = { isCancellationRequested: false };
    const result = await resolveAliasDefinition(model, position, token, '/repo', async () => {
      token.isCancellationRequested = true;
      return reply;
    });

    expect(result).toBeNull();
  });

  it('sends other open buffers for a TS model and none for a non-TS one', async () => {
    const sent: Parameters<QueryDefinition>[0][] = [];
    const query: QueryDefinition = async (input) => {
      sent.push(input);
      return reply;
    };
    const asked: string[] = [];
    const buffers = (clicked: string) => {
      asked.push(clicked);
      return { '/repo/src/foo.ts': 'unsaved' };
    };
    const token = { isCancellationRequested: false };

    await resolveAliasDefinition(model, position, token, '/repo', query, buffers);
    const css = { ...model, getLanguageId: () => 'css' };
    await resolveAliasDefinition(css, position, token, '/repo', query, buffers);

    expect(sent.map((input) => input.openBuffers)).toEqual([
      { '/repo/src/foo.ts': 'unsaved' },
      undefined,
    ]);
    expect(asked).toEqual(['/repo/src/a.ts']);
  });
});

describe('collectOpenBuffers', () => {
  const tab = (overrides: Partial<OpenFile>): OpenFile => ({
    path: 'src/foo.ts',
    name: 'foo.ts',
    content: 'unsaved',
    isDirty: true,
    projectPath: '/repo',
    ...overrides,
  });

  it('keeps only unsaved JS/TS tabs whose absolute path is known', () => {
    const buffers = collectOpenBuffers([
      tab({}),
      tab({ path: '/other/src/b.tsx', projectPath: undefined }),
      tab({ path: 'src/clean.ts', isDirty: false }),
      tab({ path: 'src/kept.ts', projectPath: undefined }),
      tab({ path: 'src/styles.css' }),
      tab({ path: 'src/loading.ts', content: undefined }),
      tab({ path: 'src/huge.ts', content: 'x'.repeat(2 * 1024 * 1024 + 1) }),
    ]);

    expect(buffers).toEqual({
      '/repo/src/foo.ts': 'unsaved',
      '/other/src/b.tsx': 'unsaved',
      '/repo/src/huge.ts': null,
    });
  });

  // The clicked file travels as fileContent; it must not use up a slot the target needs.
  it('leaves out the clicked file before the count cap and marks tabs past it', () => {
    const tabs = Array.from({ length: 22 }, (_, i) => tab({ path: `src/t${i}.ts` }));
    const buffers = collectOpenBuffers(tabs, '/repo/src/t0.ts');

    expect(Object.values(buffers).filter((text) => text !== null)).toHaveLength(20);
    expect(buffers).not.toHaveProperty('/repo/src/t0.ts');
    expect(buffers['/repo/src/t20.ts']).toBe('unsaved');
    expect(buffers['/repo/src/t21.ts']).toBeNull();
  });

  it('marks a tab that would push the total past the cap but keeps smaller ones after it', () => {
    const big = 'x'.repeat(1.9 * 1024 * 1024);
    const buffers = collectOpenBuffers([
      ...Array.from({ length: 4 }, (_, i) => tab({ path: `src/big${i}.ts`, content: big })),
      tab({ path: 'src/over.ts', content: big }),
      tab({ path: 'src/small.ts' }),
    ]);

    expect(buffers['/repo/src/over.ts']).toBeNull();
    expect(buffers['/repo/src/big3.ts']).toBe(big);
    expect(buffers['/repo/src/small.ts']).toBe('unsaved');
  });

  it('reads the unsaved tabs from the editor state', () => {
    appStore.set(openFilesAtom, [tab({}), tab({ path: 'src/a.ts' })]);
    try {
      expect(openTabBuffers('/repo/src/a.ts')).toEqual({ '/repo/src/foo.ts': 'unsaved' });
    } finally {
      appStore.set(openFilesAtom, []);
    }
  });
});
