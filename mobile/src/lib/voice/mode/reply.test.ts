import { describe, expect, it } from 'vitest';
import type { MobileChatDetail, MobileMessage } from '@frink/shared/types/remote/mobile';
import { CODE_ONLY, DONE, follow, readReply, startReading, type ReplyReader } from './reply';

const user = (id: string, text: string): MobileMessage => ({ id, role: 'user', text });
const assistant = (id: string, text: string): MobileMessage => ({ id, role: 'assistant', text });

/** Feeds snapshots in order and collects every line read aloud. */
function readAll(
  first: MobileMessage[],
  snapshots: Array<{ messages: MobileMessage[]; running: boolean }>,
  running = false,
) {
  let reader: ReplyReader = startReading(first, running);
  const lines: string[] = [];
  for (const snapshot of snapshots) {
    const next = readReply(reader, snapshot.messages, snapshot.running);
    reader = next.reader;
    lines.push(...next.lines);
  }
  return lines;
}

describe('reading the reply', () => {
  it('never reads what was in the chat before voice mode opened', () => {
    const before = [user('u1', 'hi'), assistant('a1', 'Old reply. Already seen.')];
    expect(readAll(before, [{ messages: before, running: false }])).toEqual([]);
  });

  it('reads each new sentence once as the reply grows, then the rest when it ends', () => {
    const base = [user('u1', 'fix it')];
    const lines = readAll(base, [
      { messages: [...base, assistant('a1', 'Looking now.')], running: true },
      { messages: [...base, assistant('a1', 'Looking now. Found')], running: true },
      { messages: [...base, assistant('a1', 'Looking now. Found')], running: true },
      { messages: [...base, assistant('a1', 'Looking now. Found it. Fixed')], running: true },
      { messages: [...base, assistant('a1', 'Looking now. Found it. Fixed')], running: false },
    ]);
    expect(lines).toEqual(['Looking now.', 'Found it.', 'Fixed']);
  });

  it('works the same when snapshots skip ahead', () => {
    const base = [user('u1', 'fix it')];
    const lines = readAll(base, [
      { messages: [...base, assistant('a1', 'Looking now. Found it. Fixed')], running: false },
    ]);
    expect(lines).toEqual(['Looking now.', 'Found it.', 'Fixed']);
  });

  it('reads parts in order and a part is finished once a tool follows it', () => {
    const base = [user('u1', 'go')];
    const working: MobileMessage = {
      id: 'a1',
      role: 'assistant',
      text: '',
      parts: [
        { type: 'text', text: 'Checking the tests' },
        { type: 'tool', id: 't1', name: 'Bash', state: 'running' },
        { type: 'text', text: 'They pass. Shipping' },
      ],
    };
    expect(readAll(base, [{ messages: [...base, working], running: true }])).toEqual([
      'Checking the tests',
      'They pass.',
    ]);
  });

  it('keeps reading a reply that was already under way when voice mode opened', () => {
    const before = [user('u1', 'go'), assistant('a1', 'Started. Then')];
    const lines = readAll(
      before,
      [{ messages: [user('u1', 'go'), assistant('a1', 'Started. Then more. ')], running: true }],
      true,
    );
    expect(lines).toEqual(['Then more.']);
  });

  it('ignores user messages', () => {
    const lines = readAll(
      [],
      [{ messages: [user('u1', 'Hello there. How are you?')], running: false }],
    );
    expect(lines).toEqual([]);
  });

  it('says the code is on screen when the reply was only code', () => {
    const base = [user('u1', 'write it')];
    const lines = readAll(
      base,
      [
        { messages: base, running: true },
        { messages: [...base, assistant('a1', '```ts\nexport const x = 1;\n```')], running: false },
      ],
      false,
    );
    expect(lines).toEqual([CODE_ONLY]);
  });

  it('says done after a turn that read nothing aloud, or a long one', () => {
    const base = [user('u1', 'go')];
    expect(
      readAll(base, [
        { messages: base, running: true },
        { messages: base, running: false },
      ]),
    ).toEqual([DONE]);
    const long = assistant('a1', 'One. Two. Three. Four.');
    expect(
      readAll(base, [
        { messages: base, running: true },
        { messages: [...base, long], running: false },
      ]),
    ).toEqual(['One.', 'Two.', 'Three.', 'Four.', DONE]);
    const short = assistant('a1', 'All set.');
    expect(
      readAll(base, [
        { messages: base, running: true },
        { messages: [...base, short], running: false },
      ]),
    ).toEqual(['All set.']);
  });

  it('does not count text read while idle toward the next turn', () => {
    const idle = [user('u1', 'a'), assistant('a1', 'Done. Fixed it.')];
    const next = [...idle, user('u2', 'b'), assistant('a2', '```ts\nconst x = 1;\n```')];
    const lines = readAll(
      [],
      [
        { messages: idle, running: false },
        { messages: next, running: true },
        { messages: next, running: false },
      ],
    );
    expect(lines).toEqual(['Done.', 'Fixed it.', CODE_ONLY]);
  });

  it('ends a turn that arrived whole in one idle snapshot', () => {
    const base = [user('u1', 'go')];
    const code = [...base, assistant('a1', '```\ncode\n```')];
    expect(readAll(base, [{ messages: code, running: false }])).toEqual([CODE_ONLY]);
    const long = [...base, assistant('a1', 'One. Two. Three. Four.')];
    expect(readAll(base, [{ messages: long, running: false }])).toEqual([
      'One.',
      'Two.',
      'Three.',
      'Four.',
      DONE,
    ]);
  });

  it('counts turns with no idle snapshot between them as one', () => {
    const one = [user('u1', 'a'), assistant('a1', 'First.')];
    const two = [...one, user('u2', 'b'), assistant('a2', '```\ncode\n```')];
    const three = [...two, user('u3', 'c'), assistant('a3', '```\nmore\n```')];
    const lines = readAll(
      [],
      [
        { messages: one, running: true },
        { messages: two, running: true },
        { messages: two, running: false },
        { messages: three, running: true },
        { messages: three, running: false },
      ],
    );
    expect(lines).toEqual(['First.', CODE_ONLY]);
  });

  it('reads everything a snapshot skipped ahead to, once', () => {
    const base = [user('u1', 'go')];
    const partial = [...base, assistant('a1', 'Looking. Found')];
    const ahead = [...base, assistant('a1', 'Looking. Found it.'), assistant('a2', 'Then fixed.')];
    const lines = readAll(base, [
      { messages: partial, running: true },
      { messages: ahead, running: false },
      { messages: ahead, running: false },
    ]);
    expect(lines).toEqual(['Looking.', 'Found it.', 'Then fixed.']);
  });

  it('reads nothing again when a rollback removes messages already read', () => {
    const one = [user('u1', 'a'), assistant('a1', 'First. Second.')];
    const after = [...one, user('u2', 'b'), assistant('a2', '```\ncode\n```')];
    const lines = readAll(
      [],
      [
        { messages: one, running: true },
        { messages: one, running: false },
        { messages: [user('u1', 'a')], running: false },
        { messages: one, running: false },
        { messages: after, running: true },
        { messages: after, running: false },
      ],
    );
    expect(lines).toEqual(['First.', 'Second.', CODE_ONLY]);
  });

  it('reads nothing again when a part shrinks, and reads what it grows into next', () => {
    const base = [user('u1', 'go')];
    const lines = readAll(base, [
      { messages: [...base, assistant('a1', 'First. Second. ')], running: true },
      { messages: [...base, assistant('a1', 'First. ')], running: true },
      { messages: [...base, assistant('a1', 'First. Third. ')], running: true },
      { messages: [...base, assistant('a1', 'First. Third. ')], running: false },
    ]);
    expect(lines).toEqual(['First.', 'Second.', 'Third.']);
  });

  it('reads a part rewritten in place again, even at the same length', () => {
    const base = [user('u1', 'go')];
    const lines = readAll(base, [
      { messages: [...base, assistant('a1', 'Tests pass. ')], running: true },
      { messages: [...base, assistant('a1', 'Lint is ok. ')], running: true },
      { messages: [...base, assistant('a1', 'Lint is ok. ')], running: false },
    ]);
    expect(lines).toEqual(['Tests pass.', 'Lint is ok.']);
  });

  it('starts each turn’s count afresh', () => {
    const one = [user('u1', 'a'), assistant('a1', 'First.')];
    const two = [...one, user('u2', 'b'), assistant('a2', '```\ncode\n```')];
    const lines = readAll(
      [],
      [
        { messages: one, running: true },
        { messages: one, running: false },
        { messages: two, running: true },
        { messages: two, running: false },
      ],
    );
    expect(lines).toEqual(['First.', CODE_ONLY]);
  });
});

describe('following a conversation', () => {
  const detail = (chatId: string, subChatId: string, messages: MobileMessage[]) =>
    ({
      chat: { id: chatId, name: 'Chat', projectId: null },
      subChatId,
      subChats: [],
      messages,
      hasMore: false,
      activity: 'idle',
      kind: 'chat',
      error: null,
      questions: [],
      permissions: [],
      pendingPlanId: null,
    }) satisfies MobileChatDetail;
  const watching = (chatId: string) => ({ deviceId: 'mac', chatId, subChatId: 's' });

  it('starts afresh for another conversation, reading none of what it already holds', () => {
    const one = detail('c1', 's', [user('u1', 'a'), assistant('a1', 'First.')]);
    const two = [user('u2', 'b'), assistant('b1', 'Other chat. Old reply.')];
    const first = follow(null, watching('c1'), one);
    expect(first?.lines).toEqual([]);
    const switched = follow(first?.following ?? null, watching('c2'), detail('c2', 's', two));
    expect(switched?.lines).toEqual([]);
    const more = [...two, user('u3', 'c'), assistant('b2', 'New.')];
    const next = follow(switched?.following ?? null, watching('c2'), detail('c2', 's', more));
    expect(next?.lines).toEqual(['New.']);
  });

  it('ignores a snapshot of another conversation', () => {
    const one = detail('c1', 's', [assistant('a1', 'First.')]);
    expect(follow(null, watching('c2'), one)).toBeNull();
    expect(follow(null, { ...watching('c1'), subChatId: 'other' }, one)).toBeNull();
  });

  it('does not read a reply early when a message of the user’s lands after it', () => {
    const base = [user('u1', 'go')];
    const lines = readAll(base, [
      { messages: [...base, assistant('a1', 'Found')], running: true },
      { messages: [...base, assistant('a1', 'Found'), user('u2', 'more')], running: true },
      { messages: [...base, assistant('a1', 'Found it. '), user('u2', 'more')], running: true },
    ]);
    expect(lines).toEqual(['Found it.']);
  });
});
