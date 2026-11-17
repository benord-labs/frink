import { afterEach, describe, expect, it } from 'vitest';
import {
  claimCreatedFlowName,
  lookupCreatedFlowName,
  recordCreatedFlowId,
  releaseCreatedFlowName,
  resetCreatedFlowNames,
} from './patch-create-names';

const EXEC = 'exec-names';
const exists = async () => true;
const deleted = async () => false;

describe('claimCreatedFlowName', () => {
  afterEach(() => resetCreatedFlowNames());

  it('claims an unused name and marks it pending until the flow id is recorded', async () => {
    expect(await claimCreatedFlowName(EXEC, 'Nightly', exists)).toEqual({ ok: true });
    expect(lookupCreatedFlowName(EXEC, 'Nightly')).toEqual({ pending: true });

    recordCreatedFlowId(EXEC, 'Nightly', 'flow-1');
    expect(lookupCreatedFlowName(EXEC, 'Nightly')).toEqual({ pending: false, flowId: 'flow-1' });
  });

  it('refuses a name already created in the session, matching on trimmed case-folded name', async () => {
    await claimCreatedFlowName(EXEC, 'new flow', exists);
    recordCreatedFlowId(EXEC, 'new flow', 'flow-1');

    const claim = await claimCreatedFlowName(EXEC, '  New Flow ', exists);

    expect(claim.ok).toBe(false);
    if (claim.ok) return;
    expect(claim.message).toContain('flow-1');
    expect(claim.message).toContain('frink_flows_get');
  });

  it('refuses a name whose create is still in flight, so parallel creates make one flow', async () => {
    const [first, second] = await Promise.all([
      claimCreatedFlowName(EXEC, 'Nightly', exists),
      claimCreatedFlowName(EXEC, 'Nightly', exists),
    ]);

    expect([first.ok, second.ok]).toEqual([true, false]);
  });

  it('frees the name when the recorded flow no longer exists', async () => {
    await claimCreatedFlowName(EXEC, 'Nightly', exists);
    recordCreatedFlowId(EXEC, 'Nightly', 'flow-1');

    expect(await claimCreatedFlowName(EXEC, 'Nightly', deleted)).toEqual({ ok: true });
  });

  it('lets only one of two retries reuse a deleted flow name', async () => {
    await claimCreatedFlowName(EXEC, 'Nightly', exists);
    recordCreatedFlowId(EXEC, 'Nightly', 'flow-1');

    const [first, second] = await Promise.all([
      claimCreatedFlowName(EXEC, 'Nightly', deleted),
      claimCreatedFlowName(EXEC, 'Nightly', deleted),
    ]);

    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect(lookupCreatedFlowName(EXEC, 'Nightly')).toEqual({ pending: true });
  });

  it('keeps names separate per session and clears them on release or reset', async () => {
    await claimCreatedFlowName(EXEC, 'Nightly', exists);
    expect(await claimCreatedFlowName('other-exec', 'Nightly', exists)).toEqual({ ok: true });

    releaseCreatedFlowName(EXEC, 'Nightly');
    expect(lookupCreatedFlowName(EXEC, 'Nightly')).toBeUndefined();

    resetCreatedFlowNames('other-exec');
    expect(lookupCreatedFlowName('other-exec', 'Nightly')).toBeUndefined();
  });
});
