import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RENDERER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function productionTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionTsxFiles(path);
    if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.')) return [];
    return [path];
  });
}

function occurrenceFiles(pattern: RegExp): string[] {
  return productionTsxFiles(RENDERER_ROOT).flatMap((path) => {
    const matches = readFileSync(path, 'utf8').match(pattern) ?? [];
    return matches.map(() => relative(RENDERER_ROOT, path));
  });
}

describe('Agents root mount architecture', () => {
  it('has one Work Queue destination and one permission-response owner', () => {
    expect(occurrenceFiles(/<WorkQueue\b/g)).toEqual([
      'features/layout/AgentsDestinationPane/index.tsx',
    ]);
    expect(occurrenceFiles(/usePermissionPrompts\(\)/g)).toEqual(['App.tsx']);
    expect(occurrenceFiles(/aria-label="Permission requests"/g)).toEqual(['App.tsx']);
  });
});
