import type { ModelUsage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContextUsageTracker } from './context-usage';

function assistant(
  input: number,
  cacheRead = 0,
  cacheCreation = 0,
  parentToolUseId: string | null = null,
  model = 'claude-opus',
): SDKMessage {
  // SAFETY: the tracker reads only type, parent_tool_use_id and message.model/usage.
  return {
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: {
      model,
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
    },
  } as SDKMessage;
}

type CacheWrite = { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;

function cachingCall(
  id: string,
  cacheCreation: CacheWrite,
  {
    cacheRead = 0,
    parentToolUseId = null,
  }: { cacheRead?: number; parentToolUseId?: string | null } = {},
) {
  // SAFETY: the tracker reads only type, parent_tool_use_id and message.id/model/usage.
  return {
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: {
      id,
      model: 'claude-opus',
      usage: { input_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation: cacheCreation },
    },
  } as SDKMessage;
}

const ONE_HOUR_WRITE = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 };
const FIVE_MINUTE_WRITE = { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 };

function modelUsage(contextWindow: number): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow,
    maxOutputTokens: 0,
  };
}

function result(): SDKMessage {
  const usage = Object.fromEntries([
    ['claude-haiku', modelUsage(200_000)],
    ['claude-opus', modelUsage(1_000_000)],
  ]);
  // SAFETY: the tracker reads only type and modelUsage[*].contextWindow.
  return { type: 'result', modelUsage: usage } as SDKMessage;
}

function compactBoundary(postTokens: number): SDKMessage {
  // SAFETY: the tracker reads only type, subtype and compact_metadata.post_tokens.
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: postTokens },
  } as SDKMessage;
}

describe('createContextUsageTracker', () => {
  it('reports the last main-thread prompt size, not the turn total', () => {
    const tracker = createContextUsageTracker();
    tracker.observe(assistant(5, 1000));
    tracker.observe(assistant(10, 2000, 300));
    tracker.observe(result());
    expect(tracker.snapshot()).toEqual({ contextTokens: 2310, contextWindow: 1_000_000 });
  });

  it('ignores subagent calls, which run in their own context', () => {
    const tracker = createContextUsageTracker();
    tracker.observe(assistant(100));
    tracker.observe(assistant(90_000, 0, 0, 'task-1'));
    expect(tracker.snapshot().contextTokens).toBe(100);
  });

  it('ignores synthetic stand-in messages, which report zero usage', () => {
    const tracker = createContextUsageTracker();
    tracker.observe(assistant(50_000));
    tracker.observe(assistant(0, 0, 0, null, '<synthetic>'));
    expect(tracker.snapshot().contextTokens).toBe(50_000);
  });

  it('resets to the post-compaction size at a compact boundary', () => {
    const tracker = createContextUsageTracker();
    tracker.observe(assistant(180_000));
    tracker.observe(compactBoundary(12_000));
    expect(tracker.snapshot().contextTokens).toBe(12_000);
  });

  it('falls back to the largest window when the main model key does not match', () => {
    const tracker = createContextUsageTracker();
    tracker.observe(assistant(1, 0, 0, null, 'claude-opus[1m]'));
    tracker.observe(result());
    expect(tracker.snapshot().contextWindow).toBe(1_000_000);
    expect(createContextUsageTracker().snapshot()).toEqual({
      contextTokens: undefined,
      contextWindow: undefined,
    });
  });
});

describe('createContextUsageTracker prompt cache expiry', () => {
  const T0 = 1_000_000;
  afterEach(() => vi.useRealTimers());

  function trackerAt(time: number) {
    vi.useFakeTimers({ now: time });
    return createContextUsageTracker();
  }

  it('expires one TTL after the last main-thread call, detecting a 1h write', () => {
    const tracker = trackerAt(T0);
    tracker.observe(cachingCall('msg-1', ONE_HOUR_WRITE));
    expect(tracker.snapshot().promptCacheExpiresAt).toBe(T0 + 3_600_000);
  });

  it('picks the shorter TTL when a call writes both, since the 5m tail expires first', () => {
    const tracker = trackerAt(T0);
    tracker.observe(
      cachingCall('msg-1', { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 500 }),
    );
    expect(tracker.snapshot().promptCacheExpiresAt).toBe(T0 + 300_000);
  });

  it('anchors on the first frame of a call and ignores its later frames', () => {
    const tracker = trackerAt(T0);
    tracker.observe(cachingCall('msg-1', FIVE_MINUTE_WRITE));
    vi.setSystemTime(T0 + 30_000);
    tracker.observe(cachingCall('msg-1', ONE_HOUR_WRITE));
    expect(tracker.snapshot().promptCacheExpiresAt).toBe(T0 + 300_000);
  });

  it('keeps the known TTL across a pure cache read, re-anchoring on it', () => {
    const tracker = trackerAt(T0);
    tracker.observe(cachingCall('msg-1', ONE_HOUR_WRITE));
    vi.setSystemTime(T0 + 60_000);
    tracker.observe(cachingCall('msg-2', null, { cacheRead: 4000 }));
    expect(tracker.snapshot().promptCacheExpiresAt).toBe(T0 + 60_000 + 3_600_000);
  });

  it('clears the expiry after a call that neither read nor wrote the cache', () => {
    const tracker = trackerAt(T0);
    tracker.observe(cachingCall('msg-1', ONE_HOUR_WRITE));
    tracker.observe(cachingCall('msg-2', null));
    expect(tracker.snapshot().promptCacheExpiresAt).toBeUndefined();
  });

  it('reports no expiry until a TTL is seen, and ignores subagent calls', () => {
    const tracker = trackerAt(T0);
    tracker.observe(cachingCall('msg-1', null));
    tracker.observe(cachingCall('sub-1', ONE_HOUR_WRITE, { parentToolUseId: 'task-1' }));
    expect(tracker.snapshot().promptCacheExpiresAt).toBeUndefined();
  });

  it('clears the expiry at a compact boundary, since compaction rewrites the prompt', () => {
    const tracker = trackerAt(T0);
    tracker.observe(cachingCall('msg-1', ONE_HOUR_WRITE));
    tracker.observe(compactBoundary(12_000));
    expect(tracker.snapshot().promptCacheExpiresAt).toBeUndefined();
  });
});
