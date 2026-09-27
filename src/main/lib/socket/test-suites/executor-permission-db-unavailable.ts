import { describe, expect, it, vi } from 'vitest';
import { getDatabase } from '../../db';
import { getProjectByPath } from '../../db/repos/projects';
import { checkPermission } from '../../permissions/v2/check';
import { formatDenyReason } from '../../permissions/v2/deny-reason-format';
import { persistApprovedRule } from '../../permissions/v2/persist-approved-rule';
import * as socketClient from '../client';
import { validateToolPermission } from '../executor';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

/** Registers sc-3537 cases inside the parent `validateToolPermission (v2 wrapper)` block,
 *  whose db, project-repo, checkPermission and persist mocks they rely on. */
type DbUnavailableHarness = Pick<ExecutorPermissionHarness, 'clientPermissionBridge'> & {
  validateWithNativeReview: (
    tool: string,
    input: Record<string, unknown>,
  ) => ReturnType<typeof validateToolPermission>;
};

const DB_UNAVAILABLE_DENY = {
  allowed: false,
  message: formatDenyReason({ kind: 'db:unavailable' }),
};

export function registerPermissionDbUnavailableTests({
  clientPermissionBridge,
  validateWithNativeReview,
}: DbUnavailableHarness): void {
  describe('when the database is unavailable', () => {
    it('denies when getDatabase throws, without consulting the rules', async () => {
      vi.mocked(checkPermission).mockClear();
      vi.mocked(getDatabase).mockImplementationOnce(() => {
        throw new Error('SQLITE_CANTOPEN');
      });
      const r = await validateToolPermission('Bash', { command: 'ls' }, '/proj', 'c1', 's1');
      expect(r).toEqual(DB_UNAVAILABLE_DENY);
      expect(checkPermission).not.toHaveBeenCalled();
      expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
    });

    it('denies when the project lookup rejects', async () => {
      vi.mocked(getProjectByPath).mockRejectedValueOnce(new Error('SQLITE_BUSY'));
      const r = await validateToolPermission(
        'Edit',
        { file_path: '/proj/a.ts' },
        '/proj',
        'c1',
        's1',
      );
      expect(r).toEqual(DB_UNAVAILABLE_DENY);
    });

    it('denies when a non-Error value is thrown', async () => {
      vi.mocked(getProjectByPath).mockRejectedValueOnce('database is locked');
      const r = await validateToolPermission('Bash', { command: 'ls' }, '/proj', 'c1', 's1');
      expect(r).toEqual(DB_UNAVAILABLE_DENY);
    });

    // Provider Auto Mode only reviews the `ask` residual. Returning allowed:null here
    // would hand an unevaluable call to the provider reviewer — a fail-open.
    it('denies rather than deferring to a provider-native reviewer', async () => {
      vi.mocked(getProjectByPath).mockRejectedValueOnce(new Error('SQLITE_CANTOPEN'));
      const r = await validateWithNativeReview('mcp__vendor__write', { x: 1 });
      expect(r).toEqual(DB_UNAVAILABLE_DENY);
    });

    it('denies on a flow-driven turn instead of raising a prompt', async () => {
      vi.mocked(getProjectByPath).mockRejectedValueOnce(new Error('SQLITE_CANTOPEN'));
      const r = await validateToolPermission(
        'Bash',
        { command: 'ls' },
        '/proj',
        'flow-chat',
        's1',
        undefined,
        undefined,
        true,
      );
      expect(r).toEqual(DB_UNAVAILABLE_DENY);
      expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
    });

    // Multi-pane: several chats hit the gate together during an outage, then the DB
    // recovers. Nothing may latch — each call decides on its own read.
    it('decides concurrent calls independently and recovers once the DB is back', async () => {
      vi.mocked(getProjectByPath)
        .mockRejectedValueOnce(new Error('SQLITE_BUSY'))
        .mockRejectedValueOnce(new Error('SQLITE_BUSY'));
      const [a, b, c] = await Promise.all([
        validateToolPermission('Bash', { command: 'ls' }, '/proj', 'c1', 's1'),
        validateToolPermission('Bash', { command: 'ls' }, '/proj', 'c2', 's2'),
        validateToolPermission('Bash', { command: 'ls' }, '/proj', 'c3', 's3'),
      ]);
      expect(a).toEqual(DB_UNAVAILABLE_DENY);
      expect(b).toEqual(DB_UNAVAILABLE_DENY);
      expect(c).toEqual({ allowed: true });

      const after = await validateToolPermission('Bash', { command: 'ls' }, '/proj', 'c1', 's1');
      expect(after).toEqual({ allowed: true });
    });

    function approveOnce() {
      vi.mocked(checkPermission).mockResolvedValueOnce({
        decision: 'ask',
        prompt: { reason: 'no-matching-rule' },
      } as Awaited<ReturnType<typeof checkPermission>>);
      vi.mocked(socketClient.sendPermissionRequest).mockImplementationOnce((payload) => {
        clientPermissionBridge.lastResponseHandler?.({
          ...payload,
          approved: true,
          duration: 'always',
        });
      });
    }

    // The user explicitly approved: losing the rule write must not turn that into a
    // deny or a rejected promise.
    it('still allows an approved call when the DB fails before the rule is persisted', async () => {
      const realImpl = vi.mocked(getDatabase).getMockImplementation();
      if (!realImpl) throw new Error('Expected the parent harness to mock getDatabase');
      vi.mocked(getDatabase)
        .mockImplementationOnce(realImpl)
        .mockImplementationOnce(() => {
          throw new Error('SQLITE_CANTOPEN');
        });
      approveOnce();
      const r = await validateToolPermission('Bash', { command: 'npm test' }, '/proj', 'c1', 's1');
      expect(r).toEqual({ allowed: true });
    });

    it('still allows an approved call when persisting the rule rejects', async () => {
      vi.mocked(persistApprovedRule).mockRejectedValueOnce(new Error('SQLITE_READONLY'));
      approveOnce();
      const r = await validateToolPermission('Bash', { command: 'npm test' }, '/proj', 'c1', 's1');
      expect(r).toEqual({ allowed: true });
    });
  });
}
