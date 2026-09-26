// @vitest-environment happy-dom
/**
 * TreeItem — layout contracts used by BatchGroup (grip-column chevron, label overflow).
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TreeItem } from './TreeItem';

afterEach(() => {
  cleanup();
});

describe('TreeItem', () => {
  it('uses truncate on the label cell by default (long titles ellipsis)', () => {
    render(<TreeItem label="Label" isExpanded={false} onToggle={vi.fn()} depth={0} />);
    const labelCell = screen.getByRole('treeitem').querySelector('span.flex-1.min-w-0');
    expect(labelCell?.className).toMatch(/truncate/);
    expect(labelCell?.className).not.toMatch(/overflow-visible/);
  });

  it('uses truncate on the label cell when chevronInGripColumn (long titles ellipsis; -ml-1 aligns batch header)', () => {
    render(
      <TreeItem
        label="Batch header"
        isExpanded={false}
        onToggle={vi.fn()}
        depth={1}
        chevronInGripColumn
      />,
    );
    const labelCell = screen.getByRole('treeitem').querySelector('span.flex-1.min-w-0');
    expect(labelCell?.className).toMatch(/truncate/);
    expect(labelCell?.className).not.toMatch(/overflow-visible/);
    expect(labelCell?.className).toMatch(/-ml-1/);
  });

  // Project headers (non-grip): the collapse caret moved from a LEADING tree column to an
  // always-visible TRAILING disclosure caret, so the icon leads and the row reads as a nav row.
  it('renders an aria-hidden disclosure caret at the trailing edge for a project header with children', () => {
    render(
      <TreeItem label="frink" isExpanded={false} onToggle={vi.fn()} depth={0}>
        <div>chat</div>
      </TreeItem>,
    );
    const row = screen.getByRole('treeitem');
    const caret = row.querySelector('svg.lucide-chevron-right');
    expect(caret).toBeTruthy();
    expect(caret?.getAttribute('aria-hidden')).toBe('true');
    // The caret is the LAST element in the row (trailing); the leading element is not a chevron.
    expect(row.lastElementChild).toBe(caret);
    expect(row.firstElementChild?.tagName.toLowerCase()).not.toBe('svg');
    expect(caret?.getAttribute('class') ?? '').not.toMatch(/rotate-90/);
  });

  it('rotates the trailing caret when the project is expanded', () => {
    render(
      <TreeItem label="frink" isExpanded onToggle={vi.fn()} depth={0}>
        <div>chat</div>
      </TreeItem>,
    );
    const caret = screen.getByRole('treeitem').querySelector('svg.lucide-chevron-right');
    expect(caret?.getAttribute('class') ?? '').toMatch(/rotate-90/);
  });

  it('renders no caret for a childless non-grip row (nothing to disclose)', () => {
    render(<TreeItem label="empty" isExpanded={false} onToggle={vi.fn()} depth={0} />);
    expect(screen.getByRole('treeitem').querySelector('svg.lucide-chevron-right')).toBeNull();
  });
});
