import { describe, expect, it } from 'vitest';
import { applyChatOps } from '../../../../shared/lib/mobile-chat-ops';
import type {
  MobileChatDetail,
  MobileMessage,
  MobileMessagePart,
} from '../../../../shared/types/remote/mobile';
import { chatOps } from './diff';

const text = (value: string): MobileMessagePart => ({ type: 'text', text: value });
const tool = (state: 'running' | 'completed'): MobileMessagePart => ({
  type: 'tool',
  id: 'tool',
  name: 'Read',
  state,
});

/** A message whose `text` is built from its parts, as the desktop builds it. */
function message(id: string, parts: MobileMessagePart[] = [text(id)]): MobileMessage {
  const body = parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
  return { id, role: 'assistant', text: body, parts };
}

function chat(messages: MobileMessage[], hasMore = false): MobileChatDetail {
  return {
    chat: { id: 'chat', name: 'Chat', projectId: null },
    subChatId: 'sub-chat',
    subChats: [{ id: 'sub-chat', name: 'Chat', activity: 'running' }],
    messages,
    hasMore,
    activity: 'running',
    kind: 'chat',
    error: null,
    questions: [],
    permissions: [],
    pendingPlanId: null,
  };
}

const ids = (...names: string[]) => names.map((name) => message(name));
const reply = (...parts: MobileMessagePart[]) => chat([message('user'), message('reply', parts)]);
const question = {
  id: 'q',
  source: 'live' as const,
  chatId: 'chat',
  subChatId: 'sub-chat',
  title: 'Pick',
  questions: [],
};
const permission = {
  requestId: 'p',
  chatId: 'chat',
  subChatId: 'sub-chat',
  title: 'Run',
  description: 'ls',
  supported: true,
};
const withState = (state: Partial<MobileChatDetail>) => ({ ...chat(ids('a')), ...state });

/** Name, the chat the phone holds, the chat now, and the op kinds expected (or a resync). */
const cases: Array<[string, MobileChatDetail, MobileChatDetail, string[] | 'resync']> = [
  ['nothing changes', reply(text('Hi')), reply(text('Hi')), []],
  [
    'text grows',
    reply(text('Hi'), tool('running')),
    reply(text('Hi there'), tool('running')),
    ['append'],
  ],
  ['text is replaced at the same length', reply(text('Hello')), reply(text('Jello')), ['parts']],
  ['a part is added', reply(text('Hi')), reply(text('Hi'), tool('running')), ['parts']],
  [
    'a middle part changes',
    reply(text('Hi'), tool('running'), text('Next')),
    reply(text('Hi'), tool('completed'), text('Next')),
    ['parts'],
  ],
  [
    'parts shrink',
    reply(text('Hi'), tool('running'), text('Next')),
    reply(text('Hi'), tool('completed')),
    ['parts'],
  ],
  ['a trailing part is dropped', reply(text('Hi'), tool('running')), reply(text('Hi')), ['parts']],
  [
    'text with badge runs grows',
    reply({ type: 'text', text: 'Hi', runs: [{ text: 'Hi' }] }),
    reply({ type: 'text', text: 'Hi you', runs: [{ text: 'Hi you' }] }),
    ['parts'],
  ],
  [
    'text not built from the parts',
    reply(text('Hi')),
    chat([message('user'), { ...message('reply', [text('Hi!')]), text: 'Hi! (edited)' }]),
    ['upsert'],
  ],
  ['a message is added', chat(ids('a')), chat(ids('a', 'b')), ['upsert']],
  ['an empty chat gains a message', chat([]), chat(ids('a')), ['upsert']],
  ['a message joins mid-transcript', chat(ids('a', 'c')), chat(ids('a', 'b', 'c')), 'resync'],
  [
    'the oldest is removed from a whole chat',
    chat(ids('a', 'b', 'c')),
    chat(ids('b', 'c')),
    'resync',
  ],
  [
    'a middle one is removed from a whole chat',
    chat(ids('a', 'b', 'c')),
    chat(ids('a', 'c')),
    'resync',
  ],
  [
    'the newest is removed from a whole chat',
    chat(ids('a', 'b', 'c')),
    chat(ids('a', 'b')),
    'resync',
  ],
  ['the oldest ages out of a page', chat(ids('a', 'b', 'c'), true), chat(ids('b', 'c'), true), []],
  [
    'a middle one is removed from a page',
    chat(ids('a', 'b', 'c'), true),
    chat(ids('a', 'c'), true),
    'resync',
  ],
  [
    'the newest is removed from a page',
    chat(ids('a', 'b', 'c'), true),
    chat(ids('a', 'b'), true),
    'resync',
  ],
  [
    'a page slides by one',
    chat(ids('a', 'b', 'c'), true),
    chat(ids('b', 'c', 'd'), true),
    ['upsert'],
  ],
  [
    'a page slides by several',
    chat(ids('a', 'b', 'c', 'd'), true),
    chat(ids('d', 'e', 'f'), true),
    ['upsert', 'upsert'],
  ],
  ['activity changes', chat(ids('a')), withState({ activity: 'idle' }), ['state']],
  ['a question arrives', chat(ids('a')), withState({ questions: [question] }), ['state']],
  ['a permission arrives', chat(ids('a')), withState({ permissions: [permission] }), ['state']],
  ['an error appears', chat(ids('a')), withState({ error: 'Failed.' }), ['state']],
  ['a plan waits', chat(ids('a')), withState({ pendingPlanId: 'plan' }), ['state']],
  [
    'the chat is renamed',
    chat(ids('a')),
    withState({ chat: { id: 'chat', name: 'Renamed', projectId: null } }),
    ['state'],
  ],
  [
    'a sibling conversation changes',
    chat(ids('a')),
    withState({
      subChats: [...chat([]).subChats, { id: 'other', name: 'Other', activity: 'idle' }],
    }),
    ['state'],
  ],
  ['older pages appear', chat(ids('a')), withState({ hasMore: true }), ['state']],
  ['it becomes a Flow step', chat(ids('a')), withState({ kind: 'flow' }), ['state']],
  [
    'several at once',
    reply(text('Hi')),
    {
      ...chat([message('user'), message('reply', [text('Hi there')]), message('next')]),
      activity: 'idle',
    },
    ['append', 'upsert', 'state'],
  ],
];

/** What the phone shows of `held` for the page `now`: older messages it keeps are aged out. */
function shown(held: MobileChatDetail, now: MobileChatDetail): MobileChatDetail {
  const aged = now.hasMore ? held.messages.length - now.messages.length : 0;
  return { ...held, messages: held.messages.slice(Math.max(0, aged)) };
}

describe('chat ops', () => {
  it.each(cases)('%s', (_, before, after, expected) => {
    const patch = chatOps(before, after);
    if (expected === 'resync') return expect(patch).toBeNull();
    expect(patch?.ops.map((op) => op.op)).toEqual(expected);
    const held = applyChatOps(before, patch?.ops ?? []);
    expect(held).toEqual(patch?.held);
    expect(held === 'resync' ? held : shown(held, after)).toEqual(after);
  });

  it('resyncs when a message that aged out of the page is removed once the whole chat fits', () => {
    const slid = chatOps(chat(ids('a', 'b', 'c'), true), chat(ids('b', 'c', 'd'), true));
    expect(slid?.held.messages.map((message) => message.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(slid && chatOps(slid.held, chat(ids('b', 'c', 'd')))).toBeNull();
  });

  it('sends only the new step of a long message', () => {
    const long = text('x'.repeat(100_000));
    const ops = chatOps(reply(long), reply(long, tool('running')))?.ops;
    expect(ops).toEqual([{ op: 'parts', messageId: 'reply', from: 1, parts: [tool('running')] }]);
  });
});
