// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginCapabilityRow } from '../../../lib/plugins/plugin-view-model';
import { PluginCapabilitySection } from './index';

afterEach(cleanup);

const EMPTY_ROW: PluginCapabilityRow = {
  id: 'skills',
  label: 'Skills',
  items: [],
  emptyCopy: 'No skills in this plugin.',
};

describe('PluginCapabilitySection', () => {
  it('states an absent capability instead of hiding the row', () => {
    render(<PluginCapabilitySection row={EMPTY_ROW} />);

    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByText('No skills in this plugin.')).toBeInTheDocument();
  });

  it('counts the items it lists', () => {
    render(
      <PluginCapabilitySection
        row={{
          ...EMPTY_ROW,
          items: [
            { id: 'a', label: 'Alpha' },
            { id: 'b', label: 'Beta' },
          ],
        }}
      />,
    );

    expect(screen.getByText('Skills (2)')).toBeInTheDocument();
    expect(screen.queryByText('No skills in this plugin.')).not.toBeInTheDocument();
  });

  it('flags an item that cannot act without an explicit grant', () => {
    render(
      <PluginCapabilitySection
        row={{
          ...EMPTY_ROW,
          id: 'agent-tools',
          label: 'Agent tools',
          items: [{ id: 'write', label: 'Create story', writeRisk: true }],
        }}
      />,
    );

    expect(screen.getByText('Needs approval')).toBeInTheDocument();
  });

  it('keeps a chip row honest about an item that needs a grant', () => {
    render(
      <PluginCapabilitySection
        row={{
          ...EMPTY_ROW,
          id: 'triggers',
          label: 'Triggers',
          items: [{ id: 'write', label: 'Create story', writeRisk: true }],
        }}
        variant="chips"
      />,
    );

    expect(screen.getByText('Needs approval')).toBeInTheDocument();
  });

  it('draws the runtime grid as facts, with a word behind every glyph', () => {
    render(
      <PluginCapabilitySection
        variant="matrix"
        row={{
          id: 'works-in',
          label: 'Works in',
          emptyCopy: '',
          items: [
            {
              id: 'claude-code',
              label: 'Claude Code',
              delivers: {
                skills: true,
                commands: true,
                mcp: true,
                flowTriggers: false,
                flowActions: false,
              },
            },
            {
              id: 'codex',
              label: 'Codex',
              delivers: {
                skills: true,
                commands: false,
                mcp: true,
                flowTriggers: false,
                flowActions: true,
              },
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('Works in')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Slash commands' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Flow triggers' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Flow actions' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Flows' })).not.toBeInTheDocument();
    const codex = screen.getByRole('row', { name: /Codex/ });
    expect(
      within(codex)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['Yes', 'No', 'Yes', 'No', 'Yes']);
    const claude = screen.getByRole('row', { name: /Claude Code/ });
    expect(
      within(claude)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['Yes', 'Yes', 'Yes', 'No', 'No']);
  });

  it('shows unavailable capabilities in the grid without repeating runtime notes', () => {
    render(
      <PluginCapabilitySection
        variant="matrix"
        row={{
          id: 'works-in',
          label: 'Works in',
          emptyCopy: '',
          items: [
            {
              id: 'codex',
              label: 'Codex',
              note: 'The vendor does not ship this plugin for Codex.',
              delivers: {
                skills: false,
                commands: false,
                mcp: false,
                flowTriggers: false,
                flowActions: true,
              },
            },
          ],
        }}
      />,
    );

    const row = screen.getByRole('row', { name: /Codex/ });
    expect(within(row).getAllByText('No')).toHaveLength(4);
    expect(within(row).getAllByText('Yes')).toHaveLength(1);
    expect(
      screen.queryByText('Codex — The vendor does not ship this plugin for Codex.'),
    ).not.toBeInTheDocument();
  });

  it.each(['View source', 'Official plugin', 'Official documentation'])(
    'opens the correctly labelled %s link in the system browser',
    (label) => {
      const openExternal = vi.fn();
      vi.stubGlobal('desktopApi', { openExternal });
      render(
        <PluginCapabilitySection
          variant="fact"
          row={{
            id: 'source',
            label: 'Source',
            emptyCopy: '',
            items: [
              {
                id: 'frink_builtin',
                label: 'Frink built-in',
                href: 'https://vendor.example/integration',
                hrefLabel: label === 'View source' ? undefined : label,
              },
            ],
          }}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(openExternal).toHaveBeenCalledWith('https://vendor.example/integration');
    },
  );
});
