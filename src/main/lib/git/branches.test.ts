/**
 * Registration-contract test for the branches router.
 *
 * The procedures are defined as module-level consts and assembled in
 * createBranchesRouter() via `router({ getBranches, ... })`. tRPC's router()
 * registers whatever keys it is handed, so dropping or renaming a procedure in
 * the assembly object is NOT a type error — it silently removes the endpoint at
 * runtime. This test pins the exposed procedure set so such a regression fails
 * loudly instead of shipping a dead endpoint.
 */

import { describe, expect, it } from 'vitest';
import { createBranchesRouter } from './branches';

const EXPECTED_PROCEDURES = [
  'createBranch',
  'deleteBranch',
  'fetchRemote',
  'getBranches',
  'getWorktrees',
  'switchBranch',
] as const;

describe('createBranchesRouter', () => {
  it('exposes exactly the expected procedure set', () => {
    const procedures = Object.keys(createBranchesRouter()._def.procedures).sort();
    expect(procedures).toEqual([...EXPECTED_PROCEDURES]);
  });
});
