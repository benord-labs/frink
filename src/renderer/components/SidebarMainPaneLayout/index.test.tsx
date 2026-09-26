// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SidebarMainPaneLayout } from './index';

describe('SidebarMainPaneLayout', () => {
  it('applies the canonical inset seam and main-pane clipping', () => {
    render(
      <SidebarMainPaneLayout
        sidebar={<aside data-testid="sidebar">Sidebar</aside>}
        dock={<aside data-testid="dock">Dock</aside>}
        inset
        className="custom-layout"
        mainClassName="custom-main"
        data-testid="layout"
        aria-label="Workspace"
      >
        <section data-testid="content">Content</section>
      </SidebarMainPaneLayout>,
    );

    const layout = screen.getByTestId('layout');
    const mainPane = screen.getByTestId('content').parentElement;

    expect(layout).toHaveAttribute('aria-label', 'Workspace');
    expect(layout).toHaveClass(
      'flex',
      'min-h-0',
      'min-w-0',
      'flex-1',
      'overflow-hidden',
      'gap-1',
      'custom-layout',
    );
    expect(screen.getByTestId('sidebar')).toBe(layout.firstElementChild);
    expect(screen.getByTestId('dock')).toBe(layout.lastElementChild);
    expect(mainPane).toHaveClass(
      'flex',
      'min-h-0',
      'min-w-0',
      'flex-1',
      'flex-col',
      'overflow-hidden',
      'ml-1',
      'rounded-xl',
      'custom-main',
    );
  });

  it('removes inset-only spacing and clipping for a full-screen pane', () => {
    render(
      <SidebarMainPaneLayout inset={false} data-testid="layout">
        <section data-testid="content">Content</section>
      </SidebarMainPaneLayout>,
    );

    const layout = screen.getByTestId('layout');
    const mainPane = screen.getByTestId('content').parentElement;

    expect(layout).not.toHaveClass('gap-1');
    expect(mainPane).not.toHaveClass('ml-1');
    expect(mainPane).not.toHaveClass('rounded-xl');
    expect(layout).toContainElement(mainPane);
  });
});
