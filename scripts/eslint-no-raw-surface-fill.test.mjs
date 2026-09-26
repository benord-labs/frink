import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tsParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { noRawSurfaceFill } from '../eslint/no-raw-surface-fill.mjs';

// vitest has no globals: RuleTester registers its cases through these.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
});

const rawFill = { messageId: 'rawFill' };

ruleTester.run('no-raw-surface-fill', noRawSurfaceFill, {
  valid: [
    'const a = <div className="rounded-md border bg-card/30 p-4" />;',
    'const a = <div className="hover:bg-card dark:bg-popover/80" />;',
    'const a = <div className="bg-popover/(--glass-opacity) backdrop-filter-(--glass-filter)" />;',
    'const a = <div className="glass-card glass-float text-card-foreground bg-card-foreground" />;',
    'const a = <div className="bg-[hsl(var(--card))] bg-(--popover)" />;',
    '// A bare bg-card in a comment is prose, not a class.\nconst a = 1;',
  ],
  invalid: [
    { code: 'const a = <div className="p-2 bg-card" />;', errors: [rawFill] },
    { code: "const a = cn('p-2', 'bg-popover');", errors: [rawFill] },
    { code: 'const a = <div className={`rounded ${x} bg-card`} />;', errors: [rawFill] },
    { code: 'const a = <div className="!bg-card" />;', errors: [rawFill] },
    { code: 'const a = <div className="border-border! bg-card!" />;', errors: [rawFill] },
    {
      code: "const a = cn(open ? 'bg-card' : 'bg-muted', { 'bg-popover': floating });",
      errors: [rawFill, rawFill],
    },
    {
      code: 'const a = <div className="bg-card border bg-popover" />;',
      errors: [rawFill, rawFill],
    },
  ],
});

describe('no-raw-surface-fill allowlist', () => {
  it('is never bypassed with an inline eslint-disable under src/renderer', () => {
    const root = fileURLToPath(new URL('../src/renderer', import.meta.url));
    const bypasses = readdirSync(root, { recursive: true })
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) =>
        /eslint-disable.*frink\/no-raw-surface-fill/.test(readFileSync(join(root, file), 'utf8')),
      );
    expect(bypasses, 'allowlist the path in eslint.config.mjs instead').toEqual([]);
  });
});
