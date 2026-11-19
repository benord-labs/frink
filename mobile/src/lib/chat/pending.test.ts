import { describe, expect, it } from 'vitest';
import type { MobileMessage } from '@frink/shared/types/remote/mobile';
import {
  addPending,
  changePending,
  hasUnreconciledSend,
  markFailed,
  markSent,
  mergeTranscript,
  readPending,
  reconcile,
  STEER_REFUSED,
  STEER_UNREAD,
  type PendingEntry,
} from './pending';

const entry = (id: string, change: Partial<PendingEntry> = {}): PendingEntry => ({
  id,
  text: `Message ${id}`,
  attachments: [],
  kind: 'send',
  state: 'sending',
  ...change,
});
const saved = (id: string, text = `Message ${id}`): MobileMessage => ({ id, role: 'user', text });
const steer = (id: string, change: Partial<PendingEntry> = {}) =>
  entry(id, { kind: 'steer', state: 'sent', ...change });
/** The running reply, carrying a Steered note for each text. */
const reply = (steers: string[]): MobileMessage => ({
  id: 'reply',
  role: 'assistant',
  text: '',
  parts: steers.map((text) => ({ type: 'steer', text })),
});

describe('pending messages', () => {
  it('never shows a message twice once the computer saved it, whatever text it saved', () => {
    const server = [saved('a'), saved('b', '@report.pdf Message b')];
    const merged = mergeTranscript(server, [entry('b'), entry('c')]);
    expect(merged.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
    expect(merged[1]).toEqual(server[1]);
    expect(merged[2]).toMatchObject({ role: 'user', text: 'Message c', pending: 'sending' });
  });

  it('drops an entry by id even when the saved text differs', () => {
    const entries = [entry('a'), entry('b')];
    expect(reconcile(entries, [saved('b')], false)).toEqual([entry('a')]);
    expect(reconcile(entries, [saved('z')], false)).toBe(entries);
  });

  it('keeps a taken steer until a Steered note of its own shows', () => {
    const taken = [steer('a')];
    expect(reconcile(taken, [], true)).toBe(taken);
    expect(reconcile(taken, [reply(['Message a'])], true)).toEqual([]);
  });

  it('gives each of two steers with the same text a note of its own, in order', () => {
    const twice = [steer('a', { text: 'Same' }), steer('b', { text: 'Same' })];
    const once = reconcile(twice, [reply(['Same'])], true);
    expect(once).toEqual([{ ...twice[1], markers: 1 }]);
    expect(reconcile(once, [reply(['Same'])], true)).toBe(once);
    expect(reconcile(once, [reply(['Same', 'Same'])], true)).toEqual([]);
  });

  it('never takes a note that was there before the steer for its own', () => {
    const later = [steer('a', { markers: 1 })];
    expect(reconcile(later, [reply(['Message a'])], true)).toBe(later);
    expect(reconcile(later, [reply(['Message a', 'Message a'])], true)).toEqual([]);
  });

  it('fails a taken steer whose turn ended without its note, and clears it if the note shows', () => {
    const [ended] = reconcile([steer('a')], [], false);
    expect(ended).toMatchObject({ state: 'failed', error: STEER_UNREAD });
    expect(reconcile([ended], [reply(['Message a'])], false)).toEqual([]);
    const lost = entry('c', { kind: 'steer', state: 'failed', error: 'Can’t reach it.' });
    expect(reconcile([lost], [reply(['Message c'])], false)).toEqual([]);
    const refused = [{ ...lost, error: STEER_REFUSED }];
    expect(reconcile(refused, [reply(['Message c'])], false)).toBe(refused);
    expect(mergeTranscript([], [steer('b')])[0]).toMatchObject({ pending: 'sent' });
  });

  it('keeps the text of a failed send, and shows it as failed', () => {
    const failed = markFailed([entry('a')], 'a', 'Frink is busy.');
    expect(failed).toEqual([{ ...entry('a'), state: 'failed', error: 'Frink is busy.' }]);
    expect(mergeTranscript([], failed)[0]).toMatchObject({
      text: 'Message a',
      pending: 'failed',
      error: 'Frink is busy.',
    });
  });

  it('shows the files of a message still on its way, even with no text', () => {
    const files: PendingEntry['attachments'] = [
      { id: 'stored-1', name: 'report.pdf', kind: 'file' },
    ];
    const [shown] = mergeTranscript([], [entry('a', { text: '', attachments: files })]);
    expect(shown.parts).toEqual([
      { type: 'attachment', name: 'report.pdf', kind: 'file' },
      { type: 'text', text: '' },
    ]);
  });

  it('counts only sends still on their way as unconfirmed', () => {
    expect(hasUnreconciledSend([entry('a', { kind: 'steer' })])).toBe(false);
    expect(hasUnreconciledSend(markFailed([entry('a')], 'a', 'No'))).toBe(false);
    expect(hasUnreconciledSend([entry('a')])).toBe(true);
    expect(hasUnreconciledSend(markSent([entry('a')], 'a'))).toBe(true);
  });

  it('retries in place and forgets a conversation once nothing is pending', () => {
    const key = 'device\nchat\nsub';
    changePending(key, (entries) => addPending(entries, entry('a')));
    changePending(key, (entries) => addPending(entries, entry('b')));
    changePending(key, (entries) => addPending(entries, entry('a', { state: 'failed' })));
    expect(readPending(key).map(({ id, state }) => [id, state])).toEqual([
      ['a', 'failed'],
      ['b', 'sending'],
    ]);
    changePending(key, (entries) => reconcile(entries, [saved('a'), saved('b')], false));
    expect(readPending(key)).toEqual([]);
  });
});
