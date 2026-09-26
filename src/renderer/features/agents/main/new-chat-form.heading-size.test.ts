import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'new-chat-form.tsx'),
  'utf8',
);

// The empty-state title sizes on its own column, not the viewport, so a narrow split pane in a wide window keeps it small.
describe('new-chat-form empty-state heading size', () => {
  it('declares the hero container on the relative column', () => {
    expect(src).toMatch(/className="@container\/hero [^"]*\brelative\b[^"]*"/);
  });

  it('grows the title from the hero container width with balanced lines', () => {
    const h1 = src.match(/<h1 className="([^"]*)"/)?.[1] ?? '';
    expect(h1.split(' ')).toEqual(
      expect.arrayContaining(['text-2xl', '@min-[19.25rem]/hero:text-4xl', 'text-balance']),
    );
    expect(h1).not.toMatch(/\bmd:text-/);
  });
});
