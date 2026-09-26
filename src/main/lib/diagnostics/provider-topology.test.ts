import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetProviderTopologyForTests,
  getRuntimeTopologySnapshot,
  recordClaudeQueryStart,
  recordCodexTurnStart,
  recordConfiguredMcpTopology,
  registerActiveExecutionCountReader,
  registerClaudeSessionSummaryReader,
  registerCodexAppServerCountReader,
  registerCodexLiveTurnCountReader,
  registerOwnerlessExecutionCountReader,
} from './provider-topology';
import {
  _resetStreamCadenceForTests,
  recordCheckpointPersist,
  recordStreamChunkGap,
} from './stream-cadence';

describe('provider-topology', () => {
  beforeEach(() => {
    _resetProviderTopologyForTests();
    _resetStreamCadenceForTests();
  });

  it('records counts only and bounds the recent-start window', () => {
    registerActiveExecutionCountReader(() => 6);
    registerOwnerlessExecutionCountReader(() => 2);
    registerClaudeSessionSummaryReader(() => ({ total: 5, busy: 4, retained: 1 }));
    registerCodexAppServerCountReader(() => 3);
    registerCodexLiveTurnCountReader(() => 2);
    recordConfiguredMcpTopology({
      secret_stdio_name: { type: 'stdio', command: 'npx', args: ['secret'] },
      // Real Frink HTTP configs keep a required-but-empty command field.
      private_http_name: { type: 'cloud_api', command: '', url: 'https://private.example' },
      disabled_name: { type: 'stdio', command: 'node', enabled: false },
    });
    recordClaudeQueryStart(10_000);
    recordClaudeQueryStart(80_000);
    recordCodexTurnStart(15_000);
    recordCodexTurnStart(80_000);

    expect(getRuntimeTopologySnapshot(80_000)).toEqual({
      activeExecutionCount: 6,
      ownerlessExecutionCount: 2,
      claudeSessionCount: 5,
      claudeBusySessionCount: 4,
      claudeRetainedSessionCount: 1,
      claudeQueryStartsTotal: 2,
      claudeQueryStarts60s: 1,
      codexAppServerCount: 3,
      codexLiveTurnCount: 2,
      codexTurnStartsTotal: 2,
      codexTurnStarts60s: 1,
      configuredMcpTotal: 2,
      configuredMcpStdio: 1,
      configuredMcpHttp: 1,
      // Drained by this same call; a dedicated test covers the counters themselves.
      checkpointPersistCount: 0,
      checkpointPersistMsTotal: 0,
      checkpointPersistMsMax: 0,
      checkpointPersistPartsMax: 0,
      streamChunkGapMsMax: 0,
    });
    expect(JSON.stringify(getRuntimeTopologySnapshot(80_000))).not.toContain('secret');
    expect(JSON.stringify(getRuntimeTopologySnapshot(80_000))).not.toContain('private');
  });

  it('reports stream cadence for the window since the last sample, then resets', () => {
    // Window-scoped on purpose: an all-time peak latches on the first bad moment and then can
    // never say WHEN a stall happened, which is the only thing these fields exist to answer.
    recordCheckpointPersist(12, 40);
    recordCheckpointPersist(30, 90);
    recordStreamChunkGap(9_800);

    expect(getRuntimeTopologySnapshot(0)).toMatchObject({
      checkpointPersistCount: 2,
      checkpointPersistMsTotal: 42,
      checkpointPersistMsMax: 30,
      checkpointPersistPartsMax: 90,
      streamChunkGapMsMax: 9_800,
    });
    expect(getRuntimeTopologySnapshot(0)).toMatchObject({
      checkpointPersistCount: 0,
      checkpointPersistMsMax: 0,
      streamChunkGapMsMax: 0,
    });
  });
});
