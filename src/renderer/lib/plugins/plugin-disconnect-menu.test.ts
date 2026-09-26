import { describe, expect, it } from 'vitest';
import { disconnectMenuRows } from './plugin-disconnect-menu';

const labels = (rows: ReturnType<typeof disconnectMenuRows>) =>
  rows.map((row) => (row.kind === 'separator' ? '—' : row.label));

const on = {
  needsGrant: true,
  lifecycle: true,
  isEnabled: true,
  hasAccount: false,
  toolsConnected: false,
};

describe('disconnectMenuRows', () => {
  it('is Account details above the lifecycle once an account is live', () => {
    expect(labels(disconnectMenuRows({ ...on, hasAccount: true, hasSingleAccount: true }))).toEqual(
      ['Account details', '—', 'Turn off plugin', 'Remove plugin'],
    );
  });

  it('offers nothing while the plugin is on with no account and no tools grant — Connect is the only action', () => {
    expect(disconnectMenuRows({ ...on, hasSingleAccount: false })).toEqual([]);
  });

  it('keeps Turn off and Remove for installed packages that need no grant', () => {
    expect(
      labels(disconnectMenuRows({ ...on, needsGrant: false, hasSingleAccount: false })),
    ).toEqual(['Turn off plugin', 'Remove plugin']);
  });

  it('keeps the lifecycle for an account that is listed but not live', () => {
    expect(
      labels(disconnectMenuRows({ ...on, hasAccount: true, hasSingleAccount: false })),
    ).toEqual(['Turn off plugin', 'Remove plugin']);
  });

  it('a live tools grant alone keeps the lifecycle, with no grant row of its own: Remove is the one Disconnect', () => {
    const rows = disconnectMenuRows({ ...on, toolsConnected: true, hasSingleAccount: false });
    expect(labels(rows)).toEqual(['Turn off plugin', 'Remove plugin']);
    expect(labels(rows).some((label) => /Connect|MCP|Flows/.test(label))).toBe(false);
  });

  it('is lifecycle-only while off and skips the separator; Turn on lives in the header', () => {
    expect(
      labels(disconnectMenuRows({ ...on, isEnabled: false, hasSingleAccount: false })),
    ).toEqual(['Remove plugin']);
  });

  it('outside the lifecycle slice, only the account is reachable — no lifecycle', () => {
    expect(
      labels(
        disconnectMenuRows({ ...on, lifecycle: false, hasAccount: true, hasSingleAccount: true }),
      ),
    ).toEqual(['Account details']);
  });

  it('leads with the connect row when a grant is still missing beside a live one', () => {
    expect(
      labels(
        disconnectMenuRows({
          ...on,
          hasAccount: true,
          hasSingleAccount: true,
          connectLabel: 'Finish connecting',
        }),
      ),
    ).toEqual(['Finish connecting', 'Account details', '—', 'Turn off plugin', 'Remove plugin']);
  });

  it('renders the connect row outside the lifecycle slice, so Manage is never empty beside it', () => {
    expect(
      labels(
        disconnectMenuRows({
          ...on,
          lifecycle: false,
          hasAccount: true,
          hasSingleAccount: false,
          connectLabel: 'Finish connecting',
        }),
      ),
    ).toEqual(['Finish connecting']);
  });
});
