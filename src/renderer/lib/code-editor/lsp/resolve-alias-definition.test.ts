import { describe, expect, it } from 'vitest';
import { type QueryDefinition, resolveAliasDefinition } from './resolve-alias-definition';

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

  it('drops a reply that arrives after the request was cancelled', async () => {
    const result = await resolveAliasDefinition(
      model,
      position,
      { isCancellationRequested: true },
      '/repo',
      async () => reply,
    );

    expect(result).toBeNull();
  });
});
