import { describe, expect, it, vi } from 'vitest';
import { MESSAGE_PROVENANCE_RULE } from '../../../../../shared/lib/message-markers/message-provenance';
import * as provenanceRule from './index';

const tagged = { v: 1, delivery_id: 'd', source: 'flow', kind: 'message' } as const;
const newClient = () => ({ sendRequest: vi.fn() });

/** Start one turn and have Codex accept it; returns whether it carried the rule. */
function acceptedTurn(client: ReturnType<typeof newClient>, isTagged = true): boolean {
  const turn = provenanceRule.beginTurn(client, 'th', isTagged);
  turn.settle();
  return turn.carriesRule;
}

describe('rule carried with a record', () => {
  it('rides the first tagged turn only', () => {
    const client = newClient();
    expect([acceptedTurn(client), acceptedTurn(client)]).toEqual([true, false]);
  });

  it('rides the retry when the turn that carried it never started', () => {
    const client = newClient();
    expect(provenanceRule.beginTurn(client, 'th', true).carriesRule).toBe(true);
    expect(acceptedTurn(client)).toBe(true);
  });

  it('never rides an untagged turn', () => {
    const client = newClient();
    expect([acceptedTurn(client, false), acceptedTurn(client)]).toEqual([false, true]);
  });

  it('is restated on the next turn after a compaction', () => {
    const client = newClient();
    acceptedTurn(client);
    acceptedTurn(client);
    provenanceRule.forgetOnCompaction(client, 'th');
    expect([acceptedTurn(client), acceptedTurn(client)]).toEqual([true, false]);
  });

  it('waits one turn when Codex still retains the copy the compaction dropped', () => {
    const client = newClient();
    acceptedTurn(client);
    provenanceRule.forgetOnCompaction(client, 'th');
    expect([acceptedTurn(client), acceptedTurn(client)]).toEqual([false, true]);
  });

  it('does not wait once an untagged turn or a steer replaced what Codex retains', () => {
    const untagged = newClient();
    acceptedTurn(untagged);
    acceptedTurn(untagged, false);
    provenanceRule.forgetOnCompaction(untagged, 'th');
    expect(acceptedTurn(untagged)).toBe(true);

    const steered = newClient();
    acceptedTurn(steered);
    provenanceRule.recordSteer(steered, 'th');
    provenanceRule.forgetOnCompaction(steered, 'th');
    expect(acceptedTurn(steered)).toBe(true);
  });

  it('stays unknown when a compaction lands while the turn carrying it is still starting', () => {
    const client = newClient();
    const turn = provenanceRule.beginTurn(client, 'th', true);
    provenanceRule.forgetOnCompaction(client, 'th');
    turn.settle();
    expect(turn.carriesRule).toBe(true);
    expect([acceptedTurn(client), acceptedTurn(client)]).toEqual([false, true]);
  });

  it('keeps a compaction that lands while an unruled turn is starting', () => {
    const client = newClient();
    acceptedTurn(client);
    const turn = provenanceRule.beginTurn(client, 'th', true);
    provenanceRule.forgetOnCompaction(client, 'th');
    turn.settle();
    expect(acceptedTurn(client)).toBe(true);
  });

  it('follows the newest accepted turn when two turns on one thread settle out of order', () => {
    const client = newClient();
    acceptedTurn(client);
    acceptedTurn(client);
    const older = provenanceRule.beginTurn(client, 'th', true);
    provenanceRule.forgetOnCompaction(client, 'th');
    const newer = provenanceRule.beginTurn(client, 'th', true);
    expect([older.carriesRule, newer.carriesRule]).toEqual([false, true]);
    newer.settle();
    older.settle();
    // Codex retains the newer turn's rule, so the next compaction still costs one turn.
    provenanceRule.forgetOnCompaction(client, 'th');
    expect([acceptedTurn(client), acceptedTurn(client)]).toEqual([false, true]);
  });

  it('tracks each thread and each client on its own', () => {
    const client = newClient();
    acceptedTurn(client);
    expect(provenanceRule.beginTurn(client, 'other', true).carriesRule).toBe(true);
    expect(acceptedTurn(newClient())).toBe(true);
  });
});

describe('rule in developer instructions', () => {
  it('is never carried by a turn, and ignores compaction', () => {
    const client = newClient();
    provenanceRule.markDurable(client, 'th');
    provenanceRule.forgetOnCompaction(client, 'th');
    provenanceRule.recordSteer(client, 'th');
    expect(acceptedTurn(client)).toBe(false);
  });

  it('follows the configured instructions for the turn’s cwd', async () => {
    const client = newClient();
    client.sendRequest.mockResolvedValue({ config: { developer_instructions: 'Use tabs.' } });
    const turn = { cwd: '/repo', messageProvenance: tagged };
    expect(await provenanceRule.developerInstructions(client, turn)).toBe(
      `Use tabs.\n\n${MESSAGE_PROVENANCE_RULE}`,
    );
    expect(client.sendRequest).toHaveBeenCalledWith('config/read', { cwd: '/repo' });
  });

  it('is the rule alone when nothing is configured, and absent for an untagged turn', async () => {
    const client = newClient();
    client.sendRequest.mockResolvedValue({ config: { developer_instructions: null } });
    expect(
      await provenanceRule.developerInstructions(client, { cwd: '/r', messageProvenance: tagged }),
    ).toBe(MESSAGE_PROVENANCE_RULE);
    expect(await provenanceRule.developerInstructions(client, { cwd: '/r' })).toBeUndefined();
    expect(client.sendRequest).toHaveBeenCalledTimes(1);
  });

  it('overrides nothing when the configured instructions cannot be read', async () => {
    for (const response of [Promise.reject(new Error('method not found')), Promise.resolve({})]) {
      const client = newClient();
      client.sendRequest.mockReturnValue(response);
      expect(
        await provenanceRule.developerInstructions(client, {
          cwd: '/r',
          messageProvenance: tagged,
        }),
      ).toBeUndefined();
    }
  });
});

describe('a hung app-server', () => {
  it('stops waiting for the configured instructions and overrides nothing', async () => {
    vi.useFakeTimers();
    try {
      const client = newClient();
      client.sendRequest.mockReturnValue(new Promise(() => {}));
      const pending = provenanceRule.developerInstructions(client, {
        cwd: '/r',
        messageProvenance: tagged,
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('compaction notification', () => {
  it('matches only a context-compaction item', () => {
    const matches = (item: { type: string }) =>
      provenanceRule.compaction.safeParse({ item }).success;
    expect(matches({ type: 'contextCompaction' })).toBe(true);
    expect(matches({ type: 'agentMessage' })).toBe(false);
    expect(provenanceRule.compaction.safeParse({}).success).toBe(false);
  });
});
