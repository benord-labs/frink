import { beforeEach, describe, expect, it } from 'vitest';
import type { ConversationTurn } from '../../../../../shared/types/execution';
import { carryUndeliveredMessages, clearUndeliveredMessagesForTests } from './undelivered-messages';

type SendOptions = {
  session?: string | null;
  history?: ConversationTurn[];
  commandFirst?: boolean;
};

const send = (
  message: string,
  personAuthored = true,
  chat = 'sub-1',
  { session = 's1', history, commandFirst = true }: SendOptions = {},
) => {
  const carried = carryUndeliveredMessages(chat, { raw: message, prompt: message }, personAuthored);
  return {
    prompt: carried.promptsFor(session, history, commandFirst).carried,
    accepted: carried.accepted,
    pushed: carried.pushed,
  };
};

describe('carryUndeliveredMessages', () => {
  beforeEach(() => clearUndeliveredMessagesForTests());

  it('leaves a prompt alone when nothing earlier is owed', () => {
    expect(send('restart the hub').prompt).toBe('restart the hub');
  });

  it('carries a message whose turn was stopped before the provider took it, as transcript', () => {
    send('restart the hub');
    const next = send('with latest code');

    expect(next.prompt.startsWith('<conversation_history>\nHuman: restart the hub\n')).toBe(true);
    expect(next.prompt.endsWith("The user's latest message is:\nwith latest code")).toBe(true);
  });

  it('stops carrying once the provider takes the prompt', () => {
    send('restart the hub');
    send('with latest code').accepted();

    expect(send('thanks').prompt).toBe('thanks');
  });

  it('carries every stopped message, oldest first', () => {
    send('first');
    send('second');
    const { prompt } = send('third');

    expect(prompt.indexOf('Human: first')).toBeLessThan(prompt.indexOf('Human: second'));
    expect(prompt.indexOf('Human: second')).toBeLessThan(prompt.indexOf('third'));
  });

  it("owes only a person's own message, but any turn carries what is owed", () => {
    send('a Flow step prompt', false);
    expect(send('hello').prompt).toBe('hello');

    expect(send('next Flow step', false).prompt).toContain('Human: hello');
  });

  it('does not carry a message that a retry is sending again', () => {
    send('restart the hub');
    const retry = send('restart the hub');
    expect(retry.prompt).toBe('restart the hub');

    // Still owed until this retry is taken: a stopped retry is carried like the original.
    expect(send('status?').prompt).toContain('Human: restart the hub');
    send('restart the hub').accepted();
    expect(send('thanks').prompt).not.toContain('restart the hub');
  });

  it('returns /compact bare and keeps what is owed for the next turn', () => {
    send('restart the hub');
    const compact = send('/compact keep the API decisions');
    expect(compact.prompt).toBe('/compact keep the API decisions');
    compact.accepted();

    const next = send('continue');
    expect(next.prompt).toContain('Human: restart the hub');
    // A stopped command is not a message to relay.
    expect(next.prompt).not.toContain('/compact');
  });

  it('sends any slash command bare and never owes it, as a local command is never taken', () => {
    send('restart the hub');
    expect(send('/review the diff').prompt).toBe('/review the diff');
    send('/clear');

    const next = send('continue');
    expect(next.prompt).toContain('Human: restart the hub');
    expect(next.prompt).not.toContain('/review');
    expect(next.prompt).not.toContain('/clear');
  });

  it('owes a message that only starts with a path, as the provider sends it to the model', () => {
    send('restart the hub');
    expect(send('/src/a.ts is broken').prompt).toContain('Human: restart the hub');

    expect(send('continue').prompt).toContain('Human: /src/a.ts is broken');
  });

  it('keeps a newer send owed when an older turn is taken late', () => {
    const older = send('first');
    send('second');
    older.accepted();

    const { prompt } = send('third');
    expect(prompt).toContain('Human: second');
    expect(prompt).not.toContain('Human: first');
  });

  it('takes a prompt once, so a later prompt hook cannot clear a newer send', () => {
    const first = send('ok');
    first.accepted();
    send('ok');
    first.accepted();

    expect(send('next').prompt).toContain('Human: ok');
  });

  it('keeps an owed message as typed and carries its tokens as a recap', () => {
    carryUndeliveredMessages(
      'sub-1',
      { raw: 'look at @[file:local:src/a.ts]', prompt: 'look at src/a.ts' },
      true,
    );
    const next = carryUndeliveredMessages(
      'sub-1',
      { raw: 'and @[skill:deploy] it', prompt: 'and deploy it' },
      true,
    ).promptsFor('s1', undefined, true).carried;

    expect(next).toContain('Human: look at src/a.ts\n');
    expect(next.endsWith("The user's latest message is:\nand deploy it")).toBe(true);
    // A retry sends the raw text again, which still matches what is owed.
    expect(
      carryUndeliveredMessages(
        'sub-1',
        { raw: 'look at @[file:local:src/a.ts]', prompt: 'look at src/a.ts' },
        true,
      ).promptsFor('s1', undefined, true).carried,
    ).not.toContain('Human: look at');
  });

  it('keeps chats apart', () => {
    send('restart the hub', true, 'sub-1');
    expect(send('hello', true, 'sub-2').prompt).toBe('hello');
  });
});

describe('a transcript a slash command went out without', () => {
  beforeEach(() => clearUndeliveredMessagesForTests());

  const history: ConversationTurn[] = [
    { role: 'user', content: 'first question', personAuthored: true },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question', personAuthored: true },
  ];
  const historyBlocks = (prompt: string) => prompt.split('<conversation_history>').length - 1;

  it('sends the command bare and replays the transcript on the next turn on a new session', () => {
    expect(send('/review', true, 'sub-1', { session: null, history }).prompt).toBe('/review');

    const next = send('fix it', true, 'sub-1', { session: 's-new', history });
    expect(historyBlocks(next.prompt)).toBe(1);
    expect(next.prompt.indexOf('Human: first question')).toBeLessThan(
      next.prompt.indexOf('Human: second question'),
    );
    expect(next.prompt).not.toContain('/review');
    expect(next.prompt.endsWith("The user's latest message is:\nfix it")).toBe(true);
  });

  it('replays it once the provider takes the turn, and again if it did not', () => {
    send('/review', true, 'sub-1', { session: null, history });
    send('fix it', true, 'sub-1', { session: 's-new', history });
    const retried = send('fix it', true, 'sub-1', { session: 's-new', history });
    expect(retried.prompt).toContain('Human: first question');

    retried.accepted();
    expect(send('thanks', true, 'sub-1', { session: 's-new', history }).prompt).toBe('thanks');
  });

  it('owes nothing when the command continued the session that already holds the chat', () => {
    send('/review', true, 'sub-1', { session: 's1', history });
    const next = send('fix it', true, 'sub-1', { session: 's1', history });
    expect(next.prompt).toBe('fix it');
    next.accepted();

    expect(send('thanks', true, 'sub-1', { session: 's-new', history }).prompt).toBe('thanks');
  });

  it('is settled by a fresh turn, which carries the whole transcript itself', () => {
    send('/review', true, 'sub-1', { session: null, history });
    send('fix it', true, 'sub-1', { session: null, history }).accepted();

    expect(send('thanks', true, 'sub-1', { session: 's-new', history }).prompt).toBe('thanks');
  });

  it('keeps the first transcript across a second command', () => {
    send('/review', true, 'sub-1', { session: null, history });
    const later = [...history, { role: 'assistant' as const, content: 'review notes' }];
    expect(send('/cost', true, 'sub-1', { session: 's-new', history: later }).prompt).toBe('/cost');

    const next = send('fix it', true, 'sub-1', { session: 's-new', history: later });
    expect(next.prompt).toContain('Human: second question');
    expect(next.prompt).not.toContain('review notes');
  });

  it.each(['/clear', '/reset', '/new'])('owes nothing once the CLI has %s', (command) => {
    send('/review', true, 'sub-1', { session: null, history });
    send(command, true, 'sub-1', { session: 's-new', history }).pushed();
    expect(send('fix it', true, 'sub-1', { session: 's-newer', history }).prompt).toBe('fix it');

    send(command, true, 'sub-2', { session: null, history }).pushed();
    expect(send('fix it', true, 'sub-2', { session: 's-new', history }).prompt).toBe('fix it');
  });

  it('keeps the transcript owed when a /clear never reached the provider', () => {
    send('/review', true, 'sub-1', { session: null, history });
    send('/clear', true, 'sub-1', { session: 's-new', history });

    expect(send('fix it', true, 'sub-1', { session: 's-new', history }).prompt).toContain(
      'Human: second question',
    );
  });

  it('keeps the transcript owed across /compact, which only summarises what the session holds', () => {
    send('/review', true, 'sub-1', { session: null, history });
    const compact = send('/compact', true, 'sub-1', { session: 's-new', history });
    expect(compact.prompt).toBe('/compact');
    compact.pushed();
    compact.accepted();

    expect(send('fix it', true, 'sub-1', { session: 's-new', history }).prompt).toContain(
      'Human: second question',
    );
  });

  it('settles nothing on push alone for an ordinary turn, which waits for the provider to take it', () => {
    send('/review', true, 'sub-1', { session: null, history });
    send('fix it', true, 'sub-1', { session: 's-new', history }).pushed();

    expect(send('again', true, 'sub-1', { session: 's-new', history }).prompt).toContain(
      'Human: second question',
    );
  });

  it('does not repeat a stopped message the transcript already holds', () => {
    send('restart the hub');
    const withStopped = [...history, { role: 'user' as const, content: 'restart the hub' }];
    send('/review', true, 'sub-1', { session: null, history: withStopped });

    const next = send('fix it', true, 'sub-1', { session: 's-new', history: withStopped });
    expect(next.prompt.split('Human: restart the hub').length - 1).toBe(1);
  });

  it('carries a message stopped after the command in the same block, after the transcript', () => {
    send('/review', true, 'sub-1', { session: null, history });
    send('stopped one', true, 'sub-1', { session: 's-new', history });

    const next = send('fix it', true, 'sub-1', { session: 's-new', history });
    expect(historyBlocks(next.prompt)).toBe(1);
    expect(next.prompt.indexOf('Human: second question')).toBeLessThan(
      next.prompt.indexOf('Human: stopped one'),
    );
  });

  it('takes the newer transcript when the session the older copy was taken on is still current', () => {
    send('/review', true, 'sub-1', { session: 's1', history });
    const later = [...history, { role: 'assistant' as const, content: 'review notes' }];
    send('/test', true, 'sub-1', { session: 's1', history: later });

    expect(send('fix it', true, 'sub-1', { session: 's-new', history: later }).prompt).toContain(
      'Assistant: review notes',
    );
  });

  it('treats a slash-shaped message as text where the runtime runs no typed commands', () => {
    const agent = { history, commandFirst: false };
    const turn = carryUndeliveredMessages('sub-1', { raw: '/fix it', prompt: '/fix it' }, true);
    const prompts = turn.promptsFor(null, history, false);
    expect(prompts.fresh).toContain('Human: second question');
    expect(prompts.fresh.endsWith('/fix it')).toBe(true);
    expect(prompts.freshCarriesHistory).toBe(true);
    turn.accepted();

    expect(send('next', true, 'sub-1', { ...agent, session: 's-new' }).prompt).toBe('next');
    expect(send('/compact', true, 'sub-1', { ...agent, session: null }).prompt).toBe('/compact');
  });

  it('builds the fresh prompt with the command bare where the runtime runs typed commands', () => {
    const prompts = carryUndeliveredMessages(
      'sub-1',
      { raw: '/review', prompt: '/review' },
      true,
    ).promptsFor(null, history, true);

    expect(prompts).toEqual({ carried: '/review', fresh: '/review', freshCarriesHistory: false });
  });

  it('keeps chats apart', () => {
    send('/review', true, 'sub-1', { session: null, history });
    expect(send('fix it', true, 'sub-2', { session: 's-new', history }).prompt).toBe('fix it');
  });
});
