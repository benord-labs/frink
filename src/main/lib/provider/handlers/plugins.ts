import { existsSync } from 'node:fs';
import { getCodexSkillRootsRpcOutcome } from '../../agent-runner/codex/skill-roots';
import {
  listStagedVendorPluginCodexSkillRoots,
  listStagedVendorPluginProjections,
} from '../../claude/session-config-dir';
import type { DispatchResult } from '../types';
import type { CategoryHandler } from './types';

/**
 * Report-only plugins delivery probe (provider-config-canonical-home
 * correction 3: a row that cannot report is how plugins went dark). The real
 * delivery is per-runtime — claude: per-session staging in
 * session-config-dir.ts; codex: the `skills/extraRoots/set` RPC at app-server
 * start. This handler makes each outcome PROBEABLE: a staged plugin whose
 * projection is missing on disk, or a codex RPC that errored, is a delivery
 * failure, not a noop.
 */
export const deliverPlugins: CategoryHandler = async ({ mode, ctx }) => {
  if (ctx.provider === 'codex') return codexProbe(mode);
  const projections = listStagedVendorPluginProjections();
  const missing = projections.filter((p) => !existsSync(p.projectionDir));
  if (missing.length > 0) {
    return {
      category: 'plugins',
      mode,
      status: 'noop',
      detail: `DELIVERY FAILURE — staged but missing claude-code projection: ${missing.map((p) => p.id).join(', ')}`,
    };
  }
  return {
    category: 'plugins',
    mode,
    status: projections.length > 0 ? 'delivered' : 'noop',
    detail:
      projections.length > 0
        ? `staged: ${projections.map((p) => p.id).join(', ')}`
        : 'no vendor plugins staged',
  };
};

/**
 * Codex delivery is an RPC on a live process — directory existence proves
 * nothing on its own, so the probe pairs the on-disk roots with the recorded
 * outcome of the last `skills/extraRoots/set` attempt.
 */
function codexProbe(mode: DispatchResult['mode']): DispatchResult {
  const roots = listStagedVendorPluginCodexSkillRoots();
  if (roots.length === 0) {
    return { category: 'plugins', mode, status: 'noop', detail: 'no codex skill roots staged' };
  }
  const rpc = getCodexSkillRootsRpcOutcome();
  if (rpc && !rpc.ok) {
    return {
      category: 'plugins',
      mode,
      status: 'noop',
      detail: `DELIVERY FAILURE — skills/extraRoots/set rejected: ${rpc.error ?? 'unknown error'}`,
    };
  }
  return {
    category: 'plugins',
    mode,
    status: rpc ? 'delivered' : 'noop',
    detail: rpc
      ? `codex skill roots registered: ${roots.join(', ')}`
      : 'staged, awaiting first codex session',
  };
}
