import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../db/schema';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';
import { findLatestPrUrl, recordPrUrl } from './pr-url';

const OLD_PR = 'https://github.com/o/r/pull/620';
const NEW_PR = 'https://github.com/o/r/pull/75';
const text = (t: string) => ({ type: 'text', text: t });

let db: TestDb;
const track = vi.fn();

beforeEach(async () => {
  db = freshDb();
  track.mockClear();
  await db.insert(schema.chats).values({ id: 'chat-1' });
});

async function readChat() {
  return db
    .select({
      prUrl: schema.chats.prUrl,
      prNumber: schema.chats.prNumber,
      updatedAt: schema.chats.updatedAt,
    })
    .from(schema.chats)
    .where(eq(schema.chats.id, 'chat-1'))
    .get();
}

describe('findLatestPrUrl', () => {
  it('returns the last PR link across text parts, ignoring non-text parts', () => {
    const parts = [
      text(`Opened ${OLD_PR}`),
      { type: 'tool-bash', text: 'https://github.com/o/r/pull/9' },
      text(`Superseded by ${NEW_PR} — done.`),
    ];
    expect(findLatestPrUrl(parts)).toEqual({ prUrl: NEW_PR, prNumber: 75 });
  });

  it('returns null when no text part contains a PR link', () => {
    expect(findLatestPrUrl([text('no links here'), { type: 'tool-x' }])).toBeNull();
  });

  it('rejects a malformed PR number but accepts a trailing path or fragment', () => {
    expect(findLatestPrUrl([text('https://github.com/o/r/pull/123abc')])).toBeNull();
    expect(findLatestPrUrl([text(`${NEW_PR}/files#r1`)])).toEqual({ prUrl: NEW_PR, prNumber: 75 });
  });
});

describe('recordPrUrl', () => {
  it('persists once and tracks once when the same link is finalized again', async () => {
    await recordPrUrl(db, 'chat-1', [text(NEW_PR)], track);
    const stale = new Date('2020-01-01T00:00:00Z');
    await db.update(schema.chats).set({ updatedAt: stale }).where(eq(schema.chats.id, 'chat-1'));

    await recordPrUrl(db, 'chat-1', [text(`Still ${NEW_PR}`)], track);

    expect(await readChat()).toEqual({ prUrl: NEW_PR, prNumber: 75, updatedAt: stale });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith({ workspaceId: 'chat-1', prNumber: 75 });
  });

  it('overwrites with the PR of a later turn', async () => {
    await recordPrUrl(db, 'chat-1', [text(OLD_PR)], track);
    await recordPrUrl(db, 'chat-1', [text(NEW_PR)], track);

    expect(await readChat()).toMatchObject({ prUrl: NEW_PR, prNumber: 75 });
    expect(track).toHaveBeenCalledTimes(2);
  });

  it('leaves the chat untouched for a turn without a link', async () => {
    await recordPrUrl(db, 'chat-1', [text('nothing to see')], track);

    expect(await readChat()).toMatchObject({ prUrl: null, prNumber: null });
    expect(track).not.toHaveBeenCalled();
  });

  it('swallows persistence failures so finalize durability is unaffected', async () => {
    db.run(sql`DROP TABLE chats`);

    await expect(recordPrUrl(db, 'chat-1', [text(NEW_PR)], track)).resolves.toBeUndefined();
    expect(track).not.toHaveBeenCalled();
  });
});
