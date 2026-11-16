import { beforeEach, describe, expect, it } from 'vitest';
import {
  carryUndeliveredMessages,
  clearUndeliveredMessagesForTests,
  forgetUndeliveredOnClear,
} from './undelivered-messages';

const send = (message: string, personAuthored = true, chat = 'sub-1') =>
  carryUndeliveredMessages(chat, { raw: message, prompt: message }, personAuthored);

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
    send('/context');

    const next = send('continue');
    expect(next.prompt).toContain('Human: restart the hub');
    expect(next.prompt).not.toContain('/review');
    expect(next.prompt).not.toContain('/context');
  });

  it('carries nothing from before a clear the CLI ran, and keeps what is owed otherwise', () => {
    const ran = { type: 'result', is_error: false };
    send('restart the hub');
    forgetUndeliveredOnClear('sub-1', '/compact', ran);
    forgetUndeliveredOnClear('sub-1', '/reset', { type: 'system' });
    forgetUndeliveredOnClear('sub-1', '/reset', { type: 'result', is_error: true });
    expect(send('status?').prompt).toContain('Human: restart the hub');

    forgetUndeliveredOnClear('sub-1', '/reset', ran);
    expect(send('hi').prompt).toBe('hi');
  });

  it('forgets only the cleared chat', () => {
    send('restart the hub', true, 'sub-1');
    send('deploy it', true, 'sub-2');
    forgetUndeliveredOnClear('sub-1', '/clear', { type: 'result', is_error: false });

    expect(send('hi', true, 'sub-1').prompt).toBe('hi');
    expect(send('hi', true, 'sub-2').prompt).toContain('Human: deploy it');
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
    );

    expect(next.prompt).toContain('Human: look at src/a.ts\n');
    expect(next.prompt.endsWith("The user's latest message is:\nand deploy it")).toBe(true);
    // A retry sends the raw text again, which still matches what is owed.
    expect(
      carryUndeliveredMessages(
        'sub-1',
        { raw: 'look at @[file:local:src/a.ts]', prompt: 'look at src/a.ts' },
        true,
      ).prompt,
    ).not.toContain('Human: look at');
  });

  it('keeps chats apart', () => {
    send('restart the hub', true, 'sub-1');
    expect(send('hello', true, 'sub-2').prompt).toBe('hello');
  });
});
