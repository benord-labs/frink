import { describe, expect, it } from 'vitest';
import { macStatus, sourceLine } from './settings-view';

describe('macStatus', () => {
  it('reads a healthy poll as connected', () => {
    expect(macStatus({ data: { executionReady: true } })).toEqual({
      label: 'Connected',
      tone: 'live',
    });
  });

  it('asks for Frink to be opened when the Mac answers but cannot run chats', () => {
    expect(macStatus({ data: { executionReady: false } })).toMatchObject({
      label: 'Frink isn’t open on your Mac',
      tone: 'attention',
    });
  });

  it('prefers an unreachable Mac over stale data from an earlier poll', () => {
    expect(
      macStatus({ data: { executionReady: true }, error: 'offline', errorStatus: 0 }),
    ).toMatchObject({ label: 'Offline', detail: expect.stringMatching(/Tailscale/), tone: 'quiet' });
  });

  it('does not blame the network when the Mac answered with an error', () => {
    const status = macStatus({ data: { executionReady: true }, error: 'boom', errorStatus: 500 });
    expect(status).toMatchObject({ label: 'Having trouble', tone: 'attention' });
    expect(status.detail).not.toMatch(/Tailscale/);
  });

  it('waits quietly for the first answer', () => {
    expect(macStatus({})).toEqual({ label: 'Checking…', tone: 'quiet' });
  });
});

describe('sourceLine', () => {
  it('joins what the build knew about its source', () => {
    expect(sourceLine({ checkout: 'frink', branch: 'main', commit: 'abc1234' })).toBe(
      'frink · main · abc1234',
    );
    expect(sourceLine({ commit: 'abc1234' })).toBe('abc1234');
    expect(sourceLine({ branch: 'main' })).toBeNull();
    expect(sourceLine(undefined)).toBeNull();
  });
});
