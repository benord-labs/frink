import { describe, expect, it } from 'vitest';
import { HIDDEN_WAKE_MARKER } from '../../../shared/lib/message-markers/hidden-wake-marker';
import type { Message } from '../db/repos/sub-chats';
import { extractTrailingUserReply } from './trailing-reply';

const user = (id: string, parts: unknown[]): Message => ({ id, role: 'user', parts });
const assistant = (id: string): Message => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text: 'done' }],
});
const text = (t: string) => ({ type: 'text', text: t });

describe('extractTrailingUserReply', () => {
  it('returns the user messages after the last assistant message', () => {
    const reply = extractTrailingUserReply([
      user('m1', [text('kick-off')]),
      assistant('a1'),
      user('m2', [text('please also handle the edge case')]),
    ]);
    expect(reply).toEqual({ text: 'please also handle the edge case', images: [] });
  });

  it('joins MULTIPLE trailing replies in order — a second pre-admission send is never dropped', () => {
    const reply = extractTrailingUserReply([
      assistant('a1'),
      user('m2', [text('first correction')]),
      user('m3', [text('and one more thing')]),
    ]);
    expect(reply?.text).toBe('first correction\n\nand one more thing');
  });

  it('a hidden-wake send is a delivery boundary — only replies typed after it ride', () => {
    const reply = extractTrailingUserReply([
      assistant('a1'),
      user('m2', [text(`${HIDDEN_WAKE_MARKER}resume nudge`)]),
      user('m3', [text('real typed reply')]),
    ]);
    expect(reply?.text).toBe('real typed reply');
  });

  it('a reply already carried by a prior continuation dispatch (before its hidden wake) is never re-delivered when that round crashed pre-stream', () => {
    const reply = extractTrailingUserReply([
      assistant('a1'),
      user('m2', [text('round-one reply')]),
      user('m3', [text(`${HIDDEN_WAKE_MARKER}round-one reply`)]),
      user('m4', [text('round-two reply')]),
    ]);
    expect(reply).toEqual({ text: 'round-two reply', images: [] });
  });

  it("zero assistant messages: the hidden wake still bounds — round one's reply stays consumed", () => {
    const reply = extractTrailingUserReply([
      user('m1', [text('original task instructions')]),
      user('m2', [text('round-one reply')]),
      user('m3', [text(`${HIDDEN_WAKE_MARKER}round-one reply`)]),
      user('m4', [text('round-two reply')]),
    ]);
    expect(reply).toEqual({ text: 'round-two reply', images: [] });
  });

  it('returns null when nothing trails the last hidden wake (everything already dispatched)', () => {
    expect(
      extractTrailingUserReply([
        assistant('a1'),
        user('m2', [text('reply')]),
        user('m3', [text(`${HIDDEN_WAKE_MARKER}reply`)]),
      ]),
    ).toBeNull();
  });

  it('carries pasted images in both persisted shapes', () => {
    const reply = extractTrailingUserReply([
      assistant('a1'),
      user('m2', [
        text('this is what broke'),
        { type: 'file', mimeType: 'image/png', data: 'BASE64A' },
        {
          type: 'data-image',
          data: { base64Data: 'BASE64B', mediaType: 'image/jpeg', filename: 'shot.jpg' },
        },
      ]),
    ]);
    expect(reply?.images).toEqual([
      { base64Data: 'BASE64A', mediaType: 'image/png' },
      { base64Data: 'BASE64B', mediaType: 'image/jpeg', filename: 'shot.jpg' },
    ]);
  });

  it('an image-only reply still counts (empty text, images ride)', () => {
    const reply = extractTrailingUserReply([
      assistant('a1'),
      user('m2', [{ type: 'file', mimeType: 'image/png', data: 'BASE64A' }]),
    ]);
    expect(reply).toEqual({
      text: 'Continue this run with the attached image(s) in mind.',
      images: [{ base64Data: 'BASE64A', mediaType: 'image/png' }],
    });
  });

  it('returns null when nothing trails the last assistant message (plain Retry → synthetic nudge)', () => {
    expect(extractTrailingUserReply([user('m1', [text('kick-off')]), assistant('a1')])).toBeNull();
  });

  it('returns null for an empty transcript', () => {
    expect(extractTrailingUserReply([])).toBeNull();
  });

  it('returns null when NO assistant message exists and only the kick-off prompt is present (first-turn pre-stream crash)', () => {
    expect(extractTrailingUserReply([user('m1', [text('original task instructions')])])).toBeNull();
  });

  it('zero assistant messages + a typed reply AFTER the kick-off → the reply rides, the kick-off does not', () => {
    const reply = extractTrailingUserReply([
      user('m1', [text('original task instructions')]),
      user('m2', [text('also please check the logs')]),
    ]);
    expect(reply).toEqual({ text: 'also please check the logs', images: [] });
  });

  it('rejects a data-image with no declared mediaType (never guesses an encoding)', () => {
    const reply = extractTrailingUserReply([
      assistant('a1'),
      user('m2', [text('pic'), { type: 'data-image', data: { base64Data: 'BASE64X' } }]),
    ]);
    expect(reply).toEqual({ text: 'pic', images: [] });
  });

  it('ignores non-image file parts and tool parts', () => {
    const reply = extractTrailingUserReply([
      assistant('a1'),
      user('m2', [
        text('with attachment'),
        { type: 'file', mimeType: 'application/pdf', data: 'PDFDATA' },
        { type: 'tool-something', state: 'result' },
      ]),
    ]);
    expect(reply).toEqual({ text: 'with attachment', images: [] });
  });
});
