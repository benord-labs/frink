import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const thisDir = dirname(fileURLToPath(import.meta.url));
const newChatFormPath = join(thisDir, 'new-chat-form.tsx');

/**
 * Regression: NewChatForm uses a centered empty-state column; wrapping the footer in
 * SplitPaneBranchBarHeightSync shifted the composer sideways in multi-pane grids.
 */
describe('new-chat-form split footer policy', () => {
  it('does not import or call useSplitPaneBranchBarSync', () => {
    const src = readFileSync(newChatFormPath, 'utf8');
    expect(src).not.toMatch(/\buseSplitPaneBranchBarSync\b/);
    expect(src).not.toMatch(/from\s+['"][^'"]*SplitPaneBranchBarHeightSync['"]/);
  });

  it('documents intentional omission of split footer sync in source', () => {
    const src = readFileSync(newChatFormPath, 'utf8');
    expect(src).toMatch(/intentionally omits? SplitPaneBranchBarHeightSync/i);
  });
});
