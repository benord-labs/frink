import { describe, expect, it } from 'vitest';
import { codeSelectionMention } from '@/lib/mentions/queued-message-text';
import { contextPathForTab, selectionFileNameForTab } from './context-file-for-tab';

const ownTab = { path: 'src/a.ts', name: 'a.ts', projectPath: '/repo', sourceChatId: 'chat-a' };
const otherProjectTab = { ...ownTab, projectPath: '/other', isOtherProject: true };

describe('contextPathForTab', () => {
  it('keeps the relative path of an ordinary tab in its own chat', () => {
    expect(contextPathForTab(ownTab, 'chat-a', false)).toEqual({ name: 'a.ts', path: 'src/a.ts' });
    expect(contextPathForTab(ownTab, 'chat-a', true)).toEqual({ name: 'a.ts', path: 'src/a.ts' });
  });

  it("gives the full path of another project's tab, in single and split view", () => {
    expect(contextPathForTab(otherProjectTab, 'chat-a', false)).toEqual({
      name: 'a.ts',
      path: '/other/src/a.ts',
    });
    expect(contextPathForTab(otherProjectTab, 'chat-a', true).path).toBe('/other/src/a.ts');
  });

  it('leaves an already-absolute path unchanged', () => {
    const tab = { ...otherProjectTab, path: '/other/src/a.ts' };
    expect(contextPathForTab(tab, 'chat-a', false).path).toBe('/other/src/a.ts');
  });

  it("gives the full path when split view writes a tab into another pane's chat", () => {
    expect(contextPathForTab(ownTab, 'chat-b', true).path).toBe('/repo/src/a.ts');
  });

  it('keeps the relative path when single view shows another chat of the same project', () => {
    expect(contextPathForTab(ownTab, 'chat-b', false).path).toBe('src/a.ts');
  });

  it('keeps the relative path of a split-view tab no chat opened', () => {
    const { sourceChatId: _, ...tab } = ownTab;
    expect(contextPathForTab(tab, 'chat-b', true).path).toBe('src/a.ts');
  });

  it('leaves the path unchanged when the tab has no project', () => {
    const { projectPath: _, ...tab } = otherProjectTab;
    expect(contextPathForTab(tab, 'chat-a', false).path).toBe('src/a.ts');
  });
});

describe('selectionFileNameForTab', () => {
  it('names an ordinary selection by its file name, as before', () => {
    expect(selectionFileNameForTab(ownTab, 'chat-a', false)).toBe('a.ts');
  });

  it("names a selection from another project's tab by full path, so its token carries it", () => {
    const fileName = selectionFileNameForTab(otherProjectTab, 'chat-a', false);
    const token = codeSelectionMention({ text: 'x', fileName, startLine: 3, endLine: 4 });

    expect(fileName).toBe('/other/src/a.ts');
    expect(token.startsWith(`@[code:${encodeURIComponent('/other/src/a.ts')}:3-4:`)).toBe(true);
  });

  it("names a selection written into another split pane's chat by full path", () => {
    expect(selectionFileNameForTab(ownTab, 'chat-b', true)).toBe('/repo/src/a.ts');
  });
});
