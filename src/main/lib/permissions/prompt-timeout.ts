import { captureMainMessage } from '../sentry/init';

/**
 * Model-visible deny reason for a permission prompt that timed out. Must make clear the user did
 * NOT deny (the CLI's canned fallback reads as a hard denial), and in an unattended flow turn it
 * steers the agent to the park contract instead of stalling.
 *
 * Also captures to Sentry: an unattended prompt timeout is a silent stall class (the agent parks
 * or proceeds degraded, nothing crashes) that auto-capture would never see. Tags only — the
 * prompt path/command stays out of telemetry.
 */
export function permissionTimeoutMessage(path: string, isFlowDrivenTurn?: boolean): string {
  captureMainMessage('Permission prompt timed out', 'warning', {
    flowDriven: String(isFlowDrivenTurn ?? false),
  });
  const flowSteer = isFlowDrivenTurn
    ? ' This is an automated flow run, so nobody may be watching prompts: either proceed without this command, or park via frink_task_signal (state: awaiting_input) asking the user to approve it, then retry after they respond.'
    : '';
  return `Permission request timed out for ${path} — the user did NOT deny it. The agent can retry; the block is not persisted.${flowSteer}`;
}
