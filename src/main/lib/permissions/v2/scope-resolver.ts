/**
 * Composes the three permission tiers into a `ScopedDocs` for the v2 dispatcher.
 * Pure orchestration — all interesting behaviour lives in `store-local` and
 * `store-policy`. The full `PermissionRequest` is accepted (matching the
 * `DocsLoader` contract) so future tickets can read `req.projectPath` /
 * `req.mode` without changing this signature.
 *
 * Ticket 07 of the permissions overhaul.
 */

import type { getDatabase } from '../../db/index';
import type { ScopedDocs } from './eval-rules';
import { getProjectDoc, getUserDoc } from './store-local';
import { getPolicyDoc } from './store-policy';
import type { PermissionRequest } from './types';

type Db = ReturnType<typeof getDatabase>;

export async function resolveScopes(db: Db, req: PermissionRequest): Promise<ScopedDocs> {
  const [policy, project, user] = await Promise.all([
    getPolicyDoc(),
    getProjectDoc(db, req.projectId),
    getUserDoc(db),
  ]);
  return { policy, project, user };
}
