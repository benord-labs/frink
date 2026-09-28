import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_PROSE_WARN_LENGTH,
  agentProseCharsLeft,
  agentProseEditRejection,
  agentProseGraphErrors,
  agentProseGraphWarnings,
  describeAgentProseOverflow,
  findAgentProseOverflow,
  isNearAgentProseCap,
  MAX_AGENT_PROSE_LENGTH,
} from './agent-prose-limit';

describe('findAgentProseOverflow', () => {
  it('accepts a field exactly at the cap and rejects one character more', () => {
    expect(findAgentProseOverflow({ instructions: 'a'.repeat(MAX_AGENT_PROSE_LENGTH) })).toBe(
      undefined,
    );
    expect(
      findAgentProseOverflow({ instructions: 'a'.repeat(MAX_AGENT_PROSE_LENGTH + 1) }),
    ).toEqual({ field: 'instructions', length: MAX_AGENT_PROSE_LENGTH + 1 });
  });

  it('measures the trimmed value — padding whitespace never pushes a fitting prompt over', () => {
    const padded = `  ${'a'.repeat(MAX_AGENT_PROSE_LENGTH)}\n\n   `;
    expect(findAgentProseOverflow({ instructions: padded })).toBeUndefined();
  });

  it('checks agentInstructions (the Role prefix) as well as instructions', () => {
    expect(
      findAgentProseOverflow({
        instructions: 'short',
        agentInstructions: 'r'.repeat(MAX_AGENT_PROSE_LENGTH + 5),
      }),
    ).toEqual({ field: 'agentInstructions', length: MAX_AGENT_PROSE_LENGTH + 5 });
  });

  it('ignores non-string values (MCP JSON can carry any shape) and a missing config', () => {
    expect(findAgentProseOverflow({ instructions: 123, agentInstructions: null })).toBeUndefined();
    expect(findAgentProseOverflow(undefined)).toBeUndefined();
  });
});

describe('near-cap band', () => {
  it('starts at the warning threshold and ends at the cap', () => {
    expect(isNearAgentProseCap(AGENT_PROSE_WARN_LENGTH - 1)).toBe(false);
    expect(isNearAgentProseCap(AGENT_PROSE_WARN_LENGTH)).toBe(true);
    expect(isNearAgentProseCap(MAX_AGENT_PROSE_LENGTH)).toBe(true);
    expect(isNearAgentProseCap(MAX_AGENT_PROSE_LENGTH + 1)).toBe(false);
  });

  it('editor counter: hidden below the threshold, never negative above the cap', () => {
    expect(agentProseCharsLeft(AGENT_PROSE_WARN_LENGTH - 1)).toBeUndefined();
    expect(agentProseCharsLeft(AGENT_PROSE_WARN_LENGTH)).toBe(
      MAX_AGENT_PROSE_LENGTH - AGENT_PROSE_WARN_LENGTH,
    );
    expect(agentProseCharsLeft(MAX_AGENT_PROSE_LENGTH + 10)).toBe(0);
  });
});

describe('describeAgentProseOverflow', () => {
  afterEach(() => vi.restoreAllMocks());

  it('formats numbers the same on every host locale (de-DE would print 50.000)', () => {
    const original = Number.prototype.toLocaleString;
    vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (
      this: number,
      locales?: Intl.LocalesArgument,
      options?: Intl.NumberFormatOptions,
    ) {
      return original.call(this, locales ?? 'de-DE', options);
    });
    expect(describeAgentProseOverflow('instructions', 62_000)).toBe(
      'instructions is 62,000 characters; the limit is 50,000',
    );
  });
});

const graphNodes = (config: Record<string, unknown>, blockType = 'agent') => [
  { id: 't', blockType: 'manual_trigger' },
  { id: 'a', blockType, label: 'Writer', config },
];

describe('agentProseGraphErrors', () => {
  it('names the node label, field and limit for over-cap instructions', () => {
    expect(agentProseGraphErrors(graphNodes({ instructions: 'a'.repeat(50_001) }))).toEqual([
      'Agent node "Writer" instructions is 50,001 characters; the limit is 50,000',
    ]);
  });

  it('is empty at exactly the cap, and for whitespace-padded cap-sized text', () => {
    expect(agentProseGraphErrors(graphNodes({ instructions: 'a'.repeat(50_000) }))).toEqual([]);
    expect(
      agentProseGraphErrors(graphNodes({ instructions: `\n ${'a'.repeat(50_000)} \n` })),
    ).toEqual([]);
  });

  it('ignores the same field names on non-agent nodes', () => {
    expect(
      agentProseGraphErrors(graphNodes({ instructions: 'a'.repeat(60_000) }, 'my-custom-node')),
    ).toEqual([]);
  });
});

describe('agentProseGraphWarnings', () => {
  it('warns in the near-cap band for each prose field, with the numbers in en-US form', () => {
    const w = agentProseGraphWarnings(
      graphNodes({ instructions: 'a'.repeat(45_000), agentInstructions: 'r'.repeat(40_000) }),
    );
    expect(w).toEqual([
      {
        nodeId: 'a',
        field: 'instructions',
        placeholder: '',
        message: 'instructions is 45,000 of 50,000 characters — near the agent prompt limit',
      },
      expect.objectContaining({ field: 'agentInstructions' }),
    ]);
  });

  it('stays silent below the threshold and over the cap (the error owns that case)', () => {
    expect(agentProseGraphWarnings(graphNodes({ instructions: 'a'.repeat(39_999) }))).toEqual([]);
    expect(agentProseGraphWarnings(graphNodes({ instructions: 'a'.repeat(50_001) }))).toEqual([]);
  });
});

describe('agentProseEditRejection (editor writes: typing, paste, command, template)', () => {
  const cap = 'a'.repeat(MAX_AGENT_PROSE_LENGTH);

  it('applies an edit that ends within the cap, measured trimmed like dispatch', () => {
    expect(agentProseEditRejection('', cap)).toBeUndefined();
    expect(agentProseEditRejection(cap, ` ${cap}\n`)).toBeUndefined();
  });

  it('refuses an edit that grows past the cap, naming the limit', () => {
    expect(agentProseEditRejection(cap, `${cap}b`)).toBe(
      'instructions is 50,001 characters; the limit is 50,000',
    );
  });

  it('lets a legacy over-cap prompt shrink, even while it is still over the cap', () => {
    const legacy = 'a'.repeat(60_000);
    expect(agentProseEditRejection(legacy, legacy.slice(1))).toBeUndefined();
    expect(agentProseEditRejection(legacy, `${legacy}b`)).toContain('60,001');
  });
});
