import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { MESSAGE_PROVENANCE_RULE } from '../../../../../shared/lib/message-markers/message-provenance';
import { buildClaudeUserMessage } from '../../claude-input-queue';
import { consumeClaudeDelivery, pushClaudeTurnDelivery, registerClaudeDelivery } from './claude';
import { createMessageProvenance } from './index';

/** The record is the LAST element: the rule that may precede it names the tag in prose too. */
const recordFrom = (text: string) =>
  JSON.parse(
    text.slice(
      text.lastIndexOf('<frink_message>') + '<frink_message>'.length,
      -'</frink_message>'.length,
    ),
  );
const session = (): Parameters<typeof registerClaudeDelivery>[0] => ({ pendingDeliveries: [] });
const record = (source: 'person' | 'flow' = 'person') =>
  createMessageProvenance({ source, kind: 'message' });

describe('defining the record on a session whose prompt predates the Flow', () => {
  const deliver = (live: ReturnType<typeof session>, text: string) => {
    registerClaudeDelivery(live, buildClaudeUserMessage(text, [], 'agent'), record('flow'), {});
    return consumeClaudeDelivery(live, { prompt: text });
  };

  it('sends the rule with the first record only, then never again', () => {
    const adopted = session();
    const first = deliver(adopted, 'step one');
    expect(first.startsWith(`${MESSAGE_PROVENANCE_RULE}\n<frink_message>`)).toBe(true);
    expect(deliver(adopted, 'step two')).not.toContain(MESSAGE_PROVENANCE_RULE);
  });

  it('sends no rule when the session prompt already carries it', () => {
    const fresh = { ...session(), provenanceRuleKnown: true };
    expect(deliver(fresh, 'step one')).not.toContain(MESSAGE_PROVENANCE_RULE);
  });
});

describe('pushClaudeTurnDelivery', () => {
  it('registers the turn record, pushes the prompt, and drops pending entries when the turn settles', async () => {
    let settle = () => {};
    const pushed: SDKUserMessage[] = [];
    const live = {
      ...session(),
      currentTurn: { messageProvenance: record('flow') },
      queue: { push: (message: SDKUserMessage) => pushed.push(message) },
      turnSettled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    const message = buildClaudeUserMessage('step', [], 'agent');
    pushClaudeTurnDelivery(live, message);
    expect(pushed).toEqual([message]);
    expect(live.pendingDeliveries).toHaveLength(1);
    settle();
    await live.turnSettled;
    expect(live.pendingDeliveries).toEqual([]);
  });
});

describe('Claude delivery association', () => {
  it('matches observed SDK string and image/plan block projections, even with absent source', () => {
    for (const [mode, images, expected] of [
      ['agent', [], '  text\n'],
      ['plan', [], 'text'],
      ['agent', [{ mediaType: 'image/png', base64Data: 'AAAA' }], 'text'],
    ] as const) {
      const live = session();
      registerClaudeDelivery(
        live,
        buildClaudeUserMessage('  text\n', [...images], mode),
        record(),
        {},
      );
      expect(recordFrom(consumeClaudeDelivery(live, { prompt: expected })).source).toBe('person');
      expect(recordFrom(consumeClaudeDelivery(live, { prompt: expected })).source).toBe('unknown');
    }
  });

  it('matches out of order and never consumes SDK entries on an explicit machine event', () => {
    const live = session(),
      turn = {};
    registerClaudeDelivery(live, buildClaudeUserMessage('step', [], 'agent'), record('flow'), turn);
    registerClaudeDelivery(live, buildClaudeUserMessage('note', [], 'agent'), record(), turn);
    expect(
      recordFrom(consumeClaudeDelivery(live, { prompt: 'step', source: 'system' })).source,
    ).toBe('internal');
    expect(recordFrom(consumeClaudeDelivery(live, { prompt: 'note', source: 'sdk' })).source).toBe(
      'person',
    );
    expect(recordFrom(consumeClaudeDelivery(live, { prompt: 'step', source: 'sdk' })).source).toBe(
      'flow',
    );
    expect(recordFrom(consumeClaudeDelivery(live, { prompt: 'other' })).source).toBe('unknown');
  });

  it('tags each of two identical steers, since their records say the same thing', () => {
    const live = session(),
      turn = {};
    const steer = () => createMessageProvenance({ source: 'person', kind: 'steer' });
    for (let i = 0; i < 2; i++)
      registerClaudeDelivery(live, buildClaudeUserMessage('stop', [], 'agent'), steer(), turn);
    for (let i = 0; i < 2; i++) {
      expect(recordFrom(consumeClaudeDelivery(live, { prompt: 'stop' }))).toMatchObject({
        source: 'person',
        kind: 'steer',
      });
    }
    expect(recordFrom(consumeClaudeDelivery(live, { prompt: 'stop' })).source).toBe('unknown');
  });

  it('consumes all ambiguous matches, expires replaced turns and caps the collection', () => {
    const live = session(),
      turn = {};
    for (const source of ['flow', 'person'] as const)
      registerClaudeDelivery(
        live,
        buildClaudeUserMessage('same', [], 'agent'),
        record(source),
        turn,
      );
    expect(recordFrom(consumeClaudeDelivery(live, { prompt: 'same' })).source).toBe('unknown');
    expect(live.pendingDeliveries).toHaveLength(0);
    registerClaudeDelivery(live, buildClaudeUserMessage('old', [], 'agent'), record(), turn);
    registerClaudeDelivery(live, buildClaudeUserMessage('new', [], 'agent'), record(), {});
    expect(recordFrom(consumeClaudeDelivery(live, { prompt: 'old' })).source).toBe('unknown');
    for (let i = 0; i < 65; i++)
      registerClaudeDelivery(live, buildClaudeUserMessage(String(i), [], 'agent'), record(), turn);
    expect(live.pendingDeliveries).toHaveLength(64);
    expect(recordFrom(consumeClaudeDelivery(live, { prompt: '0' })).source).toBe('unknown');
  });
});
