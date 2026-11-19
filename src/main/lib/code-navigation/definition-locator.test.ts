import { describe, expect, it } from 'vitest';
import { findImportBindingAt } from './definition-locator';

function bindingAt(source: string, marker: string, fileName = '/p/src/f.tsx') {
  return findImportBindingAt(source, fileName, source.lastIndexOf(marker));
}

describe('findImportBindingAt', () => {
  it.each([
    ['a named import', 'import { Foo } from "@/foo";\nFoo;', 'Foo;', '@/foo', 'Foo'],
    [
      'the original name of an aliased import',
      'import { a as b } from "./x";\nb();',
      'b()',
      './x',
      'a',
    ],
    ['a default import', 'import Def from "./d";\n<Def />;', 'Def />', './d', 'default'],
    ['a namespace import', 'import * as ns from "./n";\nns.y;', 'ns.y', './n', '*'],
    [
      'the property name inside the import itself',
      'import { a as b } from "./x";',
      'a as',
      './x',
      'a',
    ],
    ['a re-export clicked in place', 'export { size as sz } from "./x";', 'sz', './x', 'size'],
  ])('binds %s', (_label, source, marker, specifier, importedName) => {
    expect(bindingAt(source, marker)).toEqual({ specifier, importedName });
  });

  it('binds an import used in a JavaScript file', () => {
    const source = 'import { u } from "#/util";\nu();';
    expect(bindingAt(source, 'u()', '/p/src/main.js')).toEqual({
      specifier: '#/util',
      importedName: 'u',
    });
  });

  it('returns null for a parameter that shadows an import of the same name', () => {
    const source = 'import { b } from "./x";\nfunction f(b: number) { return b; }';
    expect(bindingAt(source, 'b; }')).toBeNull();
  });

  it('returns null for a local declaration and for non-identifiers', () => {
    const source = 'const local = 1;\nlocal + 2;';
    expect(bindingAt(source, 'local +')).toBeNull();
    expect(bindingAt(source, '2;')).toBeNull();
  });

  it('finds the identifier when the cursor sits just after it', () => {
    const source = 'import { Foo } from "@/foo";\nFoo;';
    expect(findImportBindingAt(source, '/p/a.ts', source.lastIndexOf(';'))).toEqual({
      specifier: '@/foo',
      importedName: 'Foo',
    });
  });
});
