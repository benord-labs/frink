// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RuleBadge } from './index';

describe('RuleBadge', () => {
  it('renders rule string verbatim and the type chip', () => {
    render(<RuleBadge ruleString="Bash(npm:*)" ruleType="allow" />);
    expect(screen.getByText('Bash(npm:*)')).toBeTruthy();
    expect(screen.getByText('allow')).toBeTruthy();
  });

  it('omits delete button when onDelete is undefined (read-only mode)', () => {
    render(<RuleBadge ruleString="Bash(rm:*)" ruleType="deny" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders delete button and fires onDelete when clicked', () => {
    const onDelete = vi.fn();
    render(<RuleBadge ruleString="Bash(npm:*)" ruleType="allow" onDelete={onDelete} />);
    const btn = screen.getByRole('button', { name: /Delete rule/i });
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('chip text reflects ruleType', () => {
    const { rerender } = render(<RuleBadge ruleString="X" ruleType="allow" />);
    expect(screen.getByText('allow')).toBeTruthy();
    rerender(<RuleBadge ruleString="X" ruleType="deny" />);
    expect(screen.getByText('deny')).toBeTruthy();
    rerender(<RuleBadge ruleString="X" ruleType="ask" />);
    expect(screen.getByText('ask')).toBeTruthy();
  });

  it('MCP rule renders friendly tool + server subtitle, NOT raw fullname', () => {
    const { container } = render(
      <RuleBadge ruleString="mcp__codebase__searchCode" ruleType="allow" />,
    );
    expect(screen.getByText('SearchCode')).toBeTruthy();
    expect(screen.getByText('codebase')).toBeTruthy();
    // Raw string should NOT render in the visible label (still in tooltip).
    expect(container.textContent ?? '').not.toContain('mcp__codebase__searchCode');
  });

  it('MCP rule with hyphenated server formats both segments', () => {
    render(<RuleBadge ruleString="mcp__shortcut-frink__stories-list" ruleType="allow" />);
    expect(screen.getByText('Stories List')).toBeTruthy();
    expect(screen.getByText('shortcut-frink')).toBeTruthy();
  });

  it('MCP wildcard renders "All tools" with server subtitle', () => {
    render(<RuleBadge ruleString="mcp__codebase__*" ruleType="allow" />);
    expect(screen.getByText('All tools')).toBeTruthy();
    expect(screen.getByText('codebase')).toBeTruthy();
  });

  it('MCP rule exposes raw string in title for power users', () => {
    const { container } = render(
      <RuleBadge ruleString="mcp__codebase__searchCode" ruleType="allow" />,
    );
    const titled = container.querySelector('[title="mcp__codebase__searchCode"]');
    expect(titled).toBeTruthy();
  });

  it('delete button still uses raw rule string in aria-label (deletion still keyed on raw)', () => {
    const onDelete = vi.fn();
    render(
      <RuleBadge ruleString="mcp__codebase__searchCode" ruleType="allow" onDelete={onDelete} />,
    );
    expect(
      screen.getByRole('button', { name: 'Delete rule mcp__codebase__searchCode' }),
    ).toBeTruthy();
  });

  it('non-MCP rule renders raw string (no MCP friendly path)', () => {
    render(<RuleBadge ruleString="Bash(npm:*)" ruleType="allow" />);
    expect(screen.getByText('Bash(npm:*)')).toBeTruthy();
    // No subtitle for non-MCP rules.
    expect(screen.queryByText(/MCP/)).toBeNull();
  });
});
