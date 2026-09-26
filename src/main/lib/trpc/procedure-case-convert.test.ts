/**
 * Guards the snake_case→camelCase IPC contract at the *procedure-export* level.
 *
 * `case-convert-middleware.test.ts` covers the transform function in isolation;
 * this file pins the wiring the flows feature actually depends on:
 *   - `publicProcedure` converts output keys to camelCase.
 *   - `publicProcedureRaw` (flows, chats.listBatchGroups) leaves snake_case untouched.
 *
 * Regressing this re-introduces the bug where snake_case DTOs (version_number,
 * node_count, SidebarBatchGroup.batch_id, …) silently became undefined in the
 * renderer. See decision `flows-ipc-casing-contract`.
 */
import { describe, expect, it, vi } from 'vitest';
import { publicProcedure, publicProcedureRaw, router } from './index';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/mock/home' : '/mock') },
}));

// Covers the exemption's full blast radius: flow-CRUD fields (version_number,
// node_count) AND batch-monitoring DTOs (stage_number, run_count, …) — all
// consumed snake_case by the renderer. Catches a partial regression where only
// some flows procedures get migrated to camelCase.
const SNAKE_PAYLOAD = {
  version_number: 1,
  node_count: 3,
  stages: [{ stage_number: 1, run_count: 2, completed_count: 1 }],
  run: { trigger_context: { lane_index: 0 } },
} as const;

const buildRouter = () =>
  router({
    converted: publicProcedure.query(() => ({ ...SNAKE_PAYLOAD })),
    raw: publicProcedureRaw.query(() => ({ ...SNAKE_PAYLOAD })),
  });

describe('tRPC procedure case-conversion contract', () => {
  it('publicProcedure converts snake_case output to camelCase (incl. nested + arrays)', async () => {
    const caller = buildRouter().createCaller({ getWindow: () => null });
    expect(await caller.converted()).toEqual({
      versionNumber: 1,
      nodeCount: 3,
      stages: [{ stageNumber: 1, runCount: 2, completedCount: 1 }],
      run: { triggerContext: { laneIndex: 0 } },
    });
  });

  it('publicProcedureRaw preserves snake_case output unchanged (flows + SidebarBatchGroup contract)', async () => {
    const caller = buildRouter().createCaller({ getWindow: () => null });
    expect(await caller.raw()).toEqual({
      version_number: 1,
      node_count: 3,
      stages: [{ stage_number: 1, run_count: 2, completed_count: 1 }],
      run: { trigger_context: { lane_index: 0 } },
    });
  });

  it('converts kebab-case keys too, which is why plugins.list opts out', async () => {
    const caller = router({
      converted: publicProcedure.query(() => ({
        runtimeSupport: { 'claude-code': { status: 'native_only' } },
      })),
      raw: publicProcedureRaw.query(() => ({
        runtimeSupport: { 'claude-code': { status: 'native_only' } },
      })),
    }).createCaller({ getWindow: () => null });

    // The middleware exists for snake_case DB rows, but it rewrites any
    // delimiter — so a map keyed by runtime id loses `claude-code` while the
    // declared type still promises it. That type-checks and throws on first
    // read, which is how it reached a QA drive rather than a test.
    expect(await caller.converted()).toEqual({
      runtimeSupport: { claudeCode: { status: 'native_only' } },
    });
    expect(await caller.raw()).toEqual({
      runtimeSupport: { 'claude-code': { status: 'native_only' } },
    });
  });
});
