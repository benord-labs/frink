import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeLocalChat } from '../../trpc/routers/chats/test-factories';
import * as schema from '../schema';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import {
  dropLinksOverlapping,
  linkProjectToChat,
  listLinkedProjectRoots,
  listLinkedProjects,
  unlinkProjectFromChat,
} from './chat-linked-projects';
import { forkChatWithSubChats, moveChatToProjectLocal } from './chats';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-links-'));
const dir = (name: string) => path.join(root, name);
for (const name of ['main', 'main/sub', 'wt', 'wt/sub', 'a', 'b', 'outer', 'outer/inner']) {
  fs.mkdirSync(dir(name), { recursive: true });
}
fs.symlinkSync(path.parse(root).root, dir('to-root'), 'dir');
afterAll(() => {
  // The link to `/` goes first, so the clean-up can never walk through it.
  fs.unlinkSync(dir('to-root'));
  fs.rmSync(root, { recursive: true, force: true });
});

const PROJECTS: Record<string, string> = {
  main: dir('main'),
  a: dir('a'),
  b: dir('b'),
  outer: dir('outer'),
  inner: dir('outer/inner'),
  nested: dir('main/sub'),
  'in-worktree': dir('wt/sub'),
  parent: root,
  gone: dir('never-created'),
  folder: 'virtual://folder',
  home: os.homedir(),
  // `/` itself when home is `/root`.
  'above-home': path.dirname(os.homedir()),
  'holds-protected': path.join(os.homedir(), '.config'),
  // `/` however it is spelled: through a link, or climbing out of a folder.
  'link-to-root': dir('to-root'),
  'climbs-to-root': root + `${path.sep}..`.repeat(root.split(path.sep).length - 1),
  'data-volume': '/System/Volumes/Data',
  'data-volume-home': path.join('/System/Volumes/Data', os.homedir()),
};

let db: TestDb;
const ids = (chatId: string) => listLinkedProjects(db, chatId).map((p) => p.id);
const rowCount = () => db.select().from(schema.chatLinkedProjects).all().length;

beforeEach(() => {
  db = freshDb();
  for (const [id, projectPath] of Object.entries(PROJECTS)) {
    db.insert(schema.projects).values({ id, name: id, path: projectPath }).run();
  }
  const chat = (id: string, projectId: string | null, worktreePath: string | null = null) =>
    db.insert(schema.chats).values(makeLocalChat({ id, projectId, worktreePath })).run();
  chat('c1', 'main', dir('wt'));
  chat('general', null);
  chat('virtual', 'folder');
});

describe('chat linked projects repo', () => {
  it('lists links in the order they were made, and unlinks idempotently', () => {
    expect(linkProjectToChat(db, 'c1', 'b')).toEqual({ ok: true });
    expect(linkProjectToChat(db, 'c1', 'a')).toEqual({ ok: true });
    expect(ids('c1')).toEqual(['b', 'a']);

    expect(unlinkProjectFromChat(db, 'c1', 'b')).toBe(true);
    expect(unlinkProjectFromChat(db, 'c1', 'b')).toBe(false);

    expect(listLinkedProjectRoots(db, 'c1')).toEqual([{ projectId: 'a', path: dir('a') }]);
  });

  it('keeps one row when the same project is linked twice', () => {
    linkProjectToChat(db, 'c1', 'a');
    expect(linkProjectToChat(db, 'c1', 'a')).toEqual({ ok: true });
    expect(rowCount()).toBe(1);
  });

  it.each([
    ['missing', 'a', 'chat-not-found'],
    ['general', 'a', 'general-chat'],
    ['virtual', 'a', 'virtual-chat'],
    ['c1', 'missing', 'project-not-found'],
    ['c1', 'main', 'main-project'],
    ['c1', 'folder', 'virtual-folder'],
    ['c1', 'gone', 'folder-missing'],
    ['c1', 'home', 'root-folder'],
    ['c1', 'above-home', 'root-folder'],
    ['c1', 'holds-protected', 'root-folder'],
    ['c1', 'link-to-root', 'root-folder'],
    ['c1', 'climbs-to-root', 'root-folder'],
    ['c1', 'nested', 'overlaps-main'],
    ['c1', 'parent', 'overlaps-main'],
    ['c1', 'in-worktree', 'overlaps-main'],
  ])('refuses to link %s to %s: %s', (chatId, projectId, reason) => {
    expect(linkProjectToChat(db, chatId, projectId)).toEqual({ ok: false, reason });
    expect(rowCount()).toBe(0);
  });

  // macOS also shows home under its data volume, and realpath keeps that spelling.
  it.runIf(process.platform === 'darwin')('refuses the data volume, which holds home', () => {
    for (const projectId of ['data-volume', 'data-volume-home']) {
      expect(linkProjectToChat(db, 'c1', projectId)).toEqual({ ok: false, reason: 'root-folder' });
    }
  });

  it('never lists a link to a virtual folder', () => {
    linkProjectToChat(db, 'c1', 'a');
    db.insert(schema.chatLinkedProjects).values({ chatId: 'c1', projectId: 'folder' }).run();

    expect(ids('c1')).toEqual(['a']);
  });

  it('drops links the chat switches its worktree into, or inside', () => {
    for (const projectId of ['a', 'b', 'outer']) linkProjectToChat(db, 'c1', projectId);

    dropLinksOverlapping(db, 'c1', [dir('outer/inner')]);
    dropLinksOverlapping(db, 'c1', [dir('b'), null]);

    expect(ids('c1')).toEqual(['a']);
  });

  it('drops links when the linked project or the chat is deleted', () => {
    linkProjectToChat(db, 'c1', 'a');
    linkProjectToChat(db, 'c1', 'b');

    db.delete(schema.projects).where(eq(schema.projects.id, 'a')).run();
    expect(ids('c1')).toEqual(['b']);

    db.delete(schema.chats).where(eq(schema.chats.id, 'c1')).run();
    expect(rowCount()).toBe(0);
  });

  it('copies links, in order, to a fork', async () => {
    linkProjectToChat(db, 'c1', 'b');
    linkProjectToChat(db, 'c1', 'a');

    const { chat } = await forkChatWithSubChats(db, 'c1');

    expect(ids(chat.id)).toEqual(['b', 'a']);
    expect(ids('c1')).toEqual(['b', 'a']);
  });

  it.each<[string, string | null, string | null, string[]]>([
    ['into a linked project', 'a', null, ['inner']],
    ['into a project holding a linked one', 'outer', null, ['a']],
    ['into a worktree holding a linked one', 'b', dir('outer'), ['a']],
    ['to a general chat', null, null, []],
    ['to a virtual folder', 'folder', null, []],
  ])('settles links on a move %s', async (_case, projectId, worktreePath, kept) => {
    linkProjectToChat(db, 'c1', 'a');
    linkProjectToChat(db, 'c1', 'inner');

    await moveChatToProjectLocal(db, 'c1', {
      projectId,
      worktreePath,
      branch: null,
      baseBranch: null,
      stalePrunedProjectId: null,
    });

    expect(ids('c1')).toEqual(kept);
  });
});
