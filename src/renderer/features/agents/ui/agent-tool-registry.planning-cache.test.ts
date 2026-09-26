// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Isolated from agent-tool-call.test.tsx so vi.resetModules() does not invalidate
 * that file's static import of AgentToolRegistry.
 */
describe('planningStatusMessageCache eviction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops oldest entry at MAX size so a revisited key can get a new random line', async () => {
    vi.resetModules();
    const { AgentToolRegistry } = await import('./agent-tool-registry');
    const title = AgentToolRegistry['tool-planning'].title;
    const randomSpy = vi.spyOn(Math, 'random');
    randomSpy.mockReturnValue(0);

    for (let i = 0; i < 200; i++) {
      title({ type: 'tool-planning', toolCallId: `evict-planning-key-${i}` });
    }

    const lineBeforeEviction = title({ type: 'tool-planning', toolCallId: 'evict-planning-key-0' });

    randomSpy.mockReturnValueOnce(1 - Number.EPSILON);
    title({ type: 'tool-planning', toolCallId: 'evict-planning-key-200' });

    randomSpy.mockReturnValueOnce(1 - Number.EPSILON);
    const lineAfterRevisit = title({ type: 'tool-planning', toolCallId: 'evict-planning-key-0' });

    expect(lineBeforeEviction).toBeTruthy();
    expect(lineAfterRevisit).not.toBe(lineBeforeEviction);
  });
});
