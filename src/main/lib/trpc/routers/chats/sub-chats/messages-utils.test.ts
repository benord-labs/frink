/**
 * Unit suite for the sub-chat message parse/paginate utilities behind
 * `getSubChatMessages`. The cases pin the truncation contract the renderer's
 * older-message pagination depends on: `before` anchors the FIRST matching id,
 * a missing anchor yields an empty window rather than throwing, and `limit: 0`
 * returns the whole array via the `slice(-0)` quirk. Those are load-bearing
 * behaviours, not accidents — changing one changes what the user sees scrolling back.
 */
import { describe, expect, it } from 'vitest';

import { paginateMessages, parseMessages } from './messages-utils';

type Msg = { id?: string };

const msgs = (...ids: string[]): Msg[] => ids.map((id) => ({ id }));

describe('parseMessages parity', () => {
  const cases: { name: string; raw: unknown; expected: Msg[] }[] = [
    {
      name: 'array input is returned unchanged',
      raw: [{ id: 'a' }, { id: 'b' }],
      expected: [{ id: 'a' }, { id: 'b' }],
    },
    { name: 'empty array passthrough', raw: [], expected: [] },
    {
      name: 'JSON string encoding an array is parsed',
      raw: '[{"id":"a"},{"id":"b"}]',
      expected: [{ id: 'a' }, { id: 'b' }],
    },
    { name: 'malformed JSON string yields []', raw: '[{bad json', expected: [] },
    { name: 'empty string yields []', raw: '', expected: [] },
    { name: 'JSON object string yields []', raw: '{}', expected: [] },
    { name: 'JSON number string yields []', raw: '5', expected: [] },
    { name: 'JSON boolean string yields []', raw: 'true', expected: [] },
    { name: 'JSON null string yields []', raw: 'null', expected: [] },
    { name: 'number input yields []', raw: 42, expected: [] },
    { name: 'null input yields []', raw: null, expected: [] },
    { name: 'undefined input yields []', raw: undefined, expected: [] },
    { name: 'plain object input yields []', raw: { id: 'a' }, expected: [] },
  ];

  it.each(cases)('$name', ({ raw, expected }) => {
    expect(parseMessages(raw)).toEqual(expected);
  });
});

describe('paginateMessages parity', () => {
  const cases: {
    name: string;
    messages: Msg[];
    limit: number;
    before: string | undefined;
    expected: { messages: Msg[]; hasMore: boolean };
  }[] = [
    {
      name: 'no beforeMessageId, length <= limit returns all',
      messages: msgs('a', 'b'),
      limit: 5,
      before: undefined,
      expected: { messages: msgs('a', 'b'), hasMore: false },
    },
    {
      name: 'no beforeMessageId, length > limit returns last N',
      messages: msgs('a', 'b', 'c', 'd'),
      limit: 2,
      before: undefined,
      expected: { messages: msgs('c', 'd'), hasMore: true },
    },
    {
      name: 'beforeMessageId mid-array with more before it (hasMore true)',
      messages: msgs('a', 'b', 'c', 'd'),
      limit: 2,
      before: 'd',
      expected: { messages: msgs('b', 'c'), hasMore: true },
    },
    {
      name: 'beforeMessageId mid-array reaching the start (hasMore false)',
      messages: msgs('a', 'b', 'c'),
      limit: 5,
      before: 'c',
      expected: { messages: msgs('a', 'b'), hasMore: false },
    },
    {
      name: 'beforeMessageId is the first element (idx === 0) yields empty',
      messages: msgs('a', 'b', 'c'),
      limit: 2,
      before: 'a',
      expected: { messages: [], hasMore: false },
    },
    {
      name: 'beforeMessageId not found (findIndex -1) yields empty, no throw',
      messages: msgs('a', 'b', 'c'),
      limit: 2,
      before: 'zzz',
      expected: { messages: [], hasMore: false },
    },
    {
      name: 'limit 0 without beforeMessageId returns the whole array (slice(-0) quirk)',
      messages: msgs('a', 'b', 'c'),
      limit: 0,
      before: undefined,
      expected: { messages: msgs('a', 'b', 'c'), hasMore: true },
    },
    {
      name: 'limit 0 with beforeMessageId mid-array returns empty',
      messages: msgs('a', 'b', 'c'),
      limit: 0,
      before: 'c',
      expected: { messages: [], hasMore: true },
    },
    {
      name: 'limit equal to length without beforeMessageId returns all',
      messages: msgs('a', 'b', 'c'),
      limit: 3,
      before: undefined,
      expected: { messages: msgs('a', 'b', 'c'), hasMore: false },
    },
    {
      name: 'empty messages without beforeMessageId',
      messages: [],
      limit: 2,
      before: undefined,
      expected: { messages: [], hasMore: false },
    },
    {
      // Duplicate ids are type-valid and reachable (e.g. a rollback re-appending an id).
      // findIndex anchors the FIRST match, so the window ends before that occurrence —
      // here [a], not [a, c] from the later duplicate. Pins the truncation contract.
      name: 'duplicate beforeMessageId anchors the first occurrence',
      messages: msgs('a', 'b', 'c', 'b'),
      limit: 5,
      before: 'b',
      expected: { messages: msgs('a'), hasMore: false },
    },
  ];

  it.each(cases)('$name', ({ messages, limit, before, expected }) => {
    expect(paginateMessages(messages, limit, before)).toEqual(expected);
  });
});
