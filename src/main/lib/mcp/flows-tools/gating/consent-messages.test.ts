import { describe, expect, it } from 'vitest';
import { FLOW_PERMISSION_SUMMARIES } from '../../../../../shared/types/flows/flow-change-presentation';
import { formatDenyReason } from '../../../permissions/v2/deny-reason-format';
import { flowPermissionSummary, isUserDecline } from './consent-messages';

describe('consent-messages — permission-store outage', () => {
  const dbUnavailable = formatDenyReason({ kind: 'db:unavailable' });

  // An unreadable permission store is a failure, not a decision: the agent must not
  // be told "the user said no, do not retry".
  it('does not classify the db:unavailable deny as a user decline', () => {
    expect(isUserDecline(dbUnavailable)).toBe(false);
  });

  it('summarises the db:unavailable deny as blocked', () => {
    expect(flowPermissionSummary(dbUnavailable)).toBe(FLOW_PERMISSION_SUMMARIES.blocked);
  });

  it('still classifies a rule denial as a user decline', () => {
    expect(isUserDecline(formatDenyReason({ kind: 'rule:deny', rule: 'Bash(rm:*)', tier: 'user' }))).toBe(true);
  });
});
