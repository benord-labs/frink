import { describe, expect, it, vi } from 'vitest';

// getToolStatus' subagent override consults transport liveness; mock the transport module so the
// real one (Sentry/trpc/etc.) never loads.
const { hasActiveTransportMock } = vi.hoisted(() => ({
  hasActiveTransportMock: vi.fn(() => false),
}));
vi.mock('../../../lib/stores/active-transport-registry', () => ({
  hasActiveTransport: hasActiveTransportMock,
}));

import type { MessagePart } from '../stores/message-store';
import { AgentToolRegistry } from './agent-tool-registry';

/**
 * Every card's `title` decides tense from `part.state`, and each closure re-derives that judgement
 * locally rather than sharing one helper. A producer writing a state the closures do not recognise
 * therefore degrades ~30 cards at once into their pending wording — "Reading" for a file already
 * read — with no error raised anywhere. That is how one stale state name went unnoticed across an
 * entire persisted transcript.
 *
 * This sweeps the registry rather than sampling it, and names no state literal inline: parts are
 * built from the constants below, so a future vocabulary split fails every card here at once
 * instead of leaking into the UI.
 */
const TERMINAL_STATE = 'output-available' as const;
const IN_FLIGHT_STATE = 'input-available' as const;

/**
 * Cards whose title is deliberately the same before and after completion, with the reason. Listed
 * rather than skipped silently so that a card losing its tense shows up as a new failure, not as a
 * quietly shrinking sweep.
 */
const STATE_INDEPENDENT_TITLES: Readonly<Record<string, string>> = {
  'tool-Edit': 'titles by filename; the rich card is AgentEditTool, not this row',
  'tool-Write': 'titles by filename; the rich card is AgentEditTool, not this row',
  'tool-Steer': 'records a user action that has already happened',
  'data-compact': 'the opening chunk is transient, so a part exists only once compaction settled',
  'tool-cloning': 'synthetic UI-only card, rendered only while pending',
  'tool-planning': 'synthetic UI-only card, rendered only while pending',
};

/** Inputs a title or subtitle closure may read. Broad so no card is skipped for want of a field. */
const REPRESENTATIVE_INPUT = {
  file_path: '/repo/src/index.ts',
  old_string: 'before\n',
  new_string: 'after\nmore\n',
  command: 'bun test',
  pattern: 'needle',
  query: 'needle',
  url: 'https://example.com',
  description: 'do the thing',
  subagent_type: 'general-purpose',
  prompt: 'go',
  flowId: 'flow-1',
  batchId: 'batch-1',
  planId: 'plan-1',
  todos: [{ content: 'step', status: 'completed' }],
  skill: 'frink',
  operations: [{ op: 'update_settings' }],
} as const;

function partWithState(type: string, state: MessagePart['state']): MessagePart {
  return {
    type,
    toolCallId: `call-${type}`,
    state,
    input: { ...REPRESENTATIVE_INPUT },
    ...(state === TERMINAL_STATE ? { output: { success: true, result: 'ok' } } : {}),
  };
}

describe('AgentToolRegistry titles distinguish finished from in-flight', () => {
  const entries = Object.keys(AgentToolRegistry);

  it('sweeps the whole registry', () => {
    expect(entries.length).toBeGreaterThan(20);
  });

  it.each(entries)('%s reads as finished once it completes', (key) => {
    const meta = AgentToolRegistry[key];
    const inFlight = meta.title(partWithState(key, IN_FLIGHT_STATE));
    const finished = meta.title(partWithState(key, TERMINAL_STATE));

    expect(finished.length).toBeGreaterThan(0);
    if (key in STATE_INDEPENDENT_TITLES) {
      expect(finished).toBe(inFlight);
      return;
    }
    expect(finished).not.toBe(inFlight);
  });

  // The diff stats are gated on the same pending judgement as the title, so when a completed Edit
  // read as pending this subtitle vanished from every collapsed and subagent-nested Edit row.
  it('keeps the Edit row diff stats once the edit completes', () => {
    const subtitle = AgentToolRegistry['tool-Edit'].subtitle?.(
      partWithState('tool-Edit', TERMINAL_STATE),
    );

    expect(subtitle).toBeTruthy();
  });
});
