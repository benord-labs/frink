import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { isSameFolder } from '../../../../shared/lib/path-normalization';
import {
  activeFilePathAtom,
  codeEditorOpenAtom,
  fileKey,
  type OpenFile,
  openFilesAtom,
} from './atoms';
import { settleBrowsedTabs, settleBrowsedTabsAtom } from './browsed-tabs';

/** A tab from ros-service opened from chat A, whose own project is /repo. */
const browsed: OpenFile = {
  path: 'src/b.ts',
  name: 'b.ts',
  projectPath: '/ros-service',
  sourceChatId: 'chat-a',
  isOtherProject: true,
};
const ordinary: OpenFile = {
  path: 'src/a.ts',
  name: 'a.ts',
  projectPath: '/repo',
  sourceChatId: 'chat-a',
};

const forChat = (chatId: string, keepProjectPaths: string[] = []) => ({
  chatId,
  mainProjectPath: '/repo',
  keepProjectPaths,
});

describe('settleBrowsedTabs', () => {
  it('keeps the tab for the chat that opened it and closes it for any other chat', () => {
    expect(settleBrowsedTabs([browsed], forChat('chat-a'))).toEqual({
      files: [browsed],
      closed: [],
    });
    expect(settleBrowsedTabs([browsed], forChat('chat-c'))).toEqual({
      files: [],
      closed: [browsed],
    });
  });

  it("keeps the tab, moved to the chat, when that chat's tree has its project", () => {
    const { files, closed } = settleBrowsedTabs([browsed], forChat('chat-c', ['/ros-service/']));

    expect(closed).toEqual([]);
    expect(files).toEqual([{ ...browsed, sourceChatId: 'chat-c' }]);
  });

  it('turns the tab into an ordinary tab of a chat whose own project it is', () => {
    const { files } = settleBrowsedTabs([browsed], {
      chatId: 'chat-c',
      mainProjectPath: '/ros-service',
      keepProjectPaths: [],
    });

    expect(files).toHaveLength(1);
    expect(files[0]?.isOtherProject).toBeUndefined();
    expect(files[0]?.sourceChatId).toBe('chat-c');
  });

  it('closes the tab for a general chat with no project', () => {
    const { closed } = settleBrowsedTabs([browsed], {
      chatId: 'chat-c',
      mainProjectPath: null,
      keepProjectPaths: [],
    });

    expect(closed).toEqual([browsed]);
  });

  it('never touches ordinary tabs, whatever their project', () => {
    const elsewhere = { ...ordinary, projectPath: '/ros-service', sourceChatId: 'chat-z' };
    const result = settleBrowsedTabs([ordinary, elsewhere], forChat('chat-c'));

    expect(result.closed).toEqual([]);
    expect(result.files[0]).toBe(ordinary);
    expect(result.files[1]).toBe(elsewhere);
  });
});

describe('isSameFolder', () => {
  it('ignores slash style, a trailing slash and Windows drive casing', () => {
    expect(isSameFolder('/repo/', '/repo')).toBe(true);
    expect(isSameFolder('C:\\Repo', 'c:/repo')).toBe(true);
    expect(isSameFolder('/repo', '/repo-two')).toBe(false);
    expect(isSameFolder('/Repo', '/repo')).toBe(false);
  });

  it('never matches a missing folder', () => {
    expect(isSameFolder(undefined, undefined)).toBe(false);
    expect(isSameFolder('', '')).toBe(false);
    expect(isSameFolder(null, '/repo')).toBe(false);
  });
});

describe('settleBrowsedTabsAtom', () => {
  function storeWith(files: OpenFile[], active: OpenFile) {
    const store = createStore();
    store.set(openFilesAtom, files);
    store.set(activeFilePathAtom, fileKey(active.path, active.projectPath));
    store.set(codeEditorOpenAtom, true);
    return store;
  }

  it('moves the active tab to a surviving tab when the active one closes', () => {
    const store = storeWith([ordinary, browsed], browsed);

    store.set(settleBrowsedTabsAtom, forChat('chat-c'));

    expect(store.get(openFilesAtom)).toEqual([ordinary]);
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/a.ts', '/repo'));
    expect(store.get(codeEditorOpenAtom)).toBe(true);
  });

  it('keeps the active tab when another tab closes', () => {
    const second: OpenFile = { ...ordinary, path: 'src/c.ts', name: 'c.ts' };
    const store = storeWith([ordinary, second, browsed], second);

    store.set(settleBrowsedTabsAtom, forChat('chat-c'));

    expect(store.get(openFilesAtom)).toEqual([ordinary, second]);
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/c.ts', '/repo'));
  });

  it('closes the editor when no tabs are left', () => {
    const store = storeWith([browsed], browsed);

    store.set(settleBrowsedTabsAtom, forChat('chat-c'));

    expect(store.get(openFilesAtom)).toEqual([]);
    expect(store.get(activeFilePathAtom)).toBeNull();
    expect(store.get(codeEditorOpenAtom)).toBe(false);
  });

  it('writes nothing when no tab changes', () => {
    const store = storeWith([ordinary, browsed], browsed);
    const before = store.get(openFilesAtom);

    store.set(settleBrowsedTabsAtom, forChat('chat-a'));

    expect(store.get(openFilesAtom)).toBe(before);
  });
});
