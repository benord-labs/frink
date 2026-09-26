import { describe, expect, it } from 'vitest';
import type { PermissionsDoc } from '../types/permissions';
import { BASE_REQUIRED_TABS, buildFamilyTabs, classifyRule } from './rule-family';

describe('classifyRule', () => {
  it('Bash tool-wide + content variants', () => {
    expect(classifyRule('Bash')).toEqual({ family: 'bash' });
    expect(classifyRule('Bash(npm:*)')).toEqual({ family: 'bash' });
    expect(classifyRule('Bash(git push:*)')).toEqual({ family: 'bash' });
  });

  it('file-op tools classified as `file`', () => {
    expect(classifyRule('Read')).toEqual({ family: 'file' });
    expect(classifyRule('Edit')).toEqual({ family: 'file' });
    expect(classifyRule('Write(src/**)')).toEqual({ family: 'file' });
    expect(classifyRule('MultiEdit')).toEqual({ family: 'file' });
    expect(classifyRule('NotebookEdit')).toEqual({ family: 'file' });
    expect(classifyRule('Delete')).toEqual({ family: 'file' });
  });

  it('MCP exact tool — extracts server name', () => {
    expect(classifyRule('mcp__codebase__searchCode')).toEqual({
      family: 'mcp',
      server: 'codebase',
    });
    expect(classifyRule('mcp__shortcut-frink__stories-list')).toEqual({
      family: 'mcp',
      server: 'shortcut-frink',
    });
  });

  it('MCP wildcard — extracts server name', () => {
    expect(classifyRule('mcp__shortcut-frink__*')).toEqual({
      family: 'mcp',
      server: 'shortcut-frink',
    });
  });

  it('agent-internal tools classified as `other`', () => {
    expect(classifyRule('Task')).toEqual({ family: 'other' });
    expect(classifyRule('TodoWrite')).toEqual({ family: 'other' });
    expect(classifyRule('WebFetch')).toEqual({ family: 'other' });
    expect(classifyRule('ExitPlanMode')).toEqual({ family: 'other' });
  });

  it('malformed rule falls back to `other`', () => {
    expect(classifyRule('not(a valid rule')).toEqual({ family: 'other' });
    expect(classifyRule('')).toEqual({ family: 'other' });
  });
});

describe('buildFamilyTabs', () => {
  it('empty doc → no tabs', () => {
    const doc: PermissionsDoc = { allow: [], deny: [], ask: [] };
    expect(buildFamilyTabs(doc)).toEqual([]);
  });

  it('single-family doc → one tab with that family’s rules split by type', () => {
    const doc: PermissionsDoc = {
      allow: ['Bash(echo:*)'],
      deny: ['Bash(rm:*)'],
      ask: [],
    };
    const tabs = buildFamilyTabs(doc);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toEqual({
      key: 'bash',
      label: 'Bash',
      bucket: { allow: ['Bash(echo:*)'], deny: ['Bash(rm:*)'], ask: [] },
    });
  });

  it('mixed-family doc → tabs ordered Bash, File ops, MCP, Other (all servers grouped under one MCP tab)', () => {
    const doc: PermissionsDoc = {
      allow: [
        'mcp__codebase__searchCode',
        'Task',
        'Read',
        'Bash(echo:*)',
        'mcp__shortcut-frink__stories-list',
      ],
      deny: [],
      ask: [],
    };
    const tabs = buildFamilyTabs(doc);
    expect(tabs.map((t) => t.key)).toEqual(['bash', 'file', 'mcp', 'other']);
    const mcp = tabs.find((t) => t.key === 'mcp');
    expect(mcp?.label).toBe('MCP');
    // Rules from every server collect into the single MCP tab.
    expect(mcp?.bucket.allow).toEqual([
      'mcp__codebase__searchCode',
      'mcp__shortcut-frink__stories-list',
    ]);
  });

  it('rules split across allow/deny within the same family land in one tab', () => {
    const doc: PermissionsDoc = {
      allow: ['mcp__codebase__*'],
      deny: ['mcp__codebase__delete'],
      ask: [],
    };
    const tabs = buildFamilyTabs(doc);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].bucket).toEqual({
      allow: ['mcp__codebase__*'],
      deny: ['mcp__codebase__delete'],
      ask: [],
    });
  });
});

describe('buildFamilyTabs — required tabs', () => {
  it('seeds the fixed Bash / File ops / MCP tabs (empty buckets) for an empty doc', () => {
    const doc: PermissionsDoc = { allow: [], deny: [], ask: [] };
    const tabs = buildFamilyTabs(doc, BASE_REQUIRED_TABS);
    expect(tabs.map((t) => t.key)).toEqual(['bash', 'file', 'mcp']);
    expect(
      tabs.every((t) => t.bucket.allow.length + t.bucket.deny.length + t.bucket.ask.length === 0),
    ).toBe(true);
  });

  it('a required family with rules is filled, not duplicated', () => {
    const doc: PermissionsDoc = { allow: ['Bash(echo:*)'], deny: [], ask: [] };
    const tabs = buildFamilyTabs(doc, BASE_REQUIRED_TABS);
    expect(tabs.map((t) => t.key)).toEqual(['bash', 'file', 'mcp']);
    expect(tabs.find((t) => t.key === 'bash')?.bucket.allow).toEqual(['Bash(echo:*)']);
    expect(tabs.find((t) => t.key === 'mcp')?.bucket).toEqual({ allow: [], deny: [], ask: [] });
  });

  it('groups all MCP rules under one MCP tab; Other trails', () => {
    const doc: PermissionsDoc = {
      allow: ['mcp__codebase__searchCode', 'mcp__shortcut-frink__*', 'Task'],
      deny: [],
      ask: [],
    };
    const tabs = buildFamilyTabs(doc, BASE_REQUIRED_TABS);
    expect(tabs.map((t) => t.key)).toEqual(['bash', 'file', 'mcp', 'other']);
    expect(tabs.find((t) => t.key === 'mcp')?.bucket.allow).toEqual([
      'mcp__codebase__searchCode',
      'mcp__shortcut-frink__*',
    ]);
  });
});
