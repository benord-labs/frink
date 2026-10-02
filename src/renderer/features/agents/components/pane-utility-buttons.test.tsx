// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaneUtilityButtons } from './pane-utility-buttons';

vi.mock('./file-tree-toggle-button', () => ({
  FileTreeToggleButton: () => <button type="button" data-testid="file-tree-toggle" />,
}));
vi.mock('./diff-toggle-button', () => ({
  DiffToggleButton: () => <button type="button" data-testid="diff-toggle" />,
}));
vi.mock('./terminal-toggle-button', () => ({
  TerminalToggleButton: () => <button type="button" data-testid="terminal-toggle" />,
}));

afterEach(cleanup);

describe('PaneUtilityButtons', () => {
  it('tints each inline button without a backdrop blur', () => {
    const { getByTestId } = render(
      <PaneUtilityButtons
        showFileTree
        showDiff
        diffStats={{ isLoading: false, hasChanges: true }}
        showTerminal
      />,
    );

    for (const id of ['file-tree-toggle', 'diff-toggle', 'terminal-toggle']) {
      const wrapper = getByTestId(id).parentElement;
      expect(wrapper).toHaveClass('rounded-md', 'bg-background/10');
      expect(wrapper?.className).not.toMatch(/backdrop-blur/);
    }
  });
});
