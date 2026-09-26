import { describe, expect, it } from 'vitest';
import { buildCdCommand, getCwdSwitchDecision, resolveExternalTerminalPath } from './cwd-switch';

describe('getCwdSwitchDecision', () => {
  it('returns ignore when next cwd is an empty string', () => {
    expect(
      getCwdSwitchDecision({
        nextCwd: '',
        requestedCwd: '/current/project',
        dismissedCwd: null,
        currentTerminalCwd: '/current/project',
        hasUserInteracted: false,
        hasPendingInput: false,
      }),
    ).toBe('ignore');
  });

  it('returns auto for pristine terminals when cwd changes', () => {
    expect(
      getCwdSwitchDecision({
        nextCwd: '/next/project',
        requestedCwd: '/current/project',
        dismissedCwd: null,
        currentTerminalCwd: '/current/project',
        hasUserInteracted: false,
        hasPendingInput: false,
      }),
    ).toBe('auto');
  });

  it('returns prompt when terminal already has user activity', () => {
    expect(
      getCwdSwitchDecision({
        nextCwd: '/next/project',
        requestedCwd: '/current/project',
        dismissedCwd: null,
        currentTerminalCwd: '/current/project',
        hasUserInteracted: true,
        hasPendingInput: false,
      }),
    ).toBe('prompt');
  });

  it('returns ignore when next cwd was explicitly dismissed', () => {
    expect(
      getCwdSwitchDecision({
        nextCwd: '/next/project',
        requestedCwd: '/current/project',
        dismissedCwd: '/next/project',
        currentTerminalCwd: '/current/project',
        hasUserInteracted: true,
        hasPendingInput: false,
      }),
    ).toBe('ignore');
  });

  it('returns ignore when next cwd is unchanged from current terminal cwd', () => {
    expect(
      getCwdSwitchDecision({
        nextCwd: '/same/project',
        requestedCwd: '/requested/project',
        dismissedCwd: null,
        currentTerminalCwd: '/same/project',
        hasUserInteracted: false,
        hasPendingInput: false,
      }),
    ).toBe('ignore');
  });

  it('returns prompt when there is pending unsent input', () => {
    expect(
      getCwdSwitchDecision({
        nextCwd: '/next/project',
        requestedCwd: '/requested/project',
        dismissedCwd: null,
        currentTerminalCwd: '/current/project',
        hasUserInteracted: false,
        hasPendingInput: true,
      }),
    ).toBe('prompt');
  });

  it('suppresses only the dismissed target cwd and allows future different cwd', () => {
    expect(
      getCwdSwitchDecision({
        nextCwd: '/project-b',
        requestedCwd: '/project-a',
        dismissedCwd: '/project-b',
        currentTerminalCwd: '/project-a',
        hasUserInteracted: true,
        hasPendingInput: false,
      }),
    ).toBe('ignore');

    expect(
      getCwdSwitchDecision({
        nextCwd: '/project-c',
        requestedCwd: '/project-a',
        dismissedCwd: '/project-b',
        currentTerminalCwd: '/project-a',
        hasUserInteracted: true,
        hasPendingInput: false,
      }),
    ).toBe('prompt');
  });

  it('handles rapid project switches by deciding on latest state only', () => {
    // Simulate A -> B (auto on pristine), then B -> C after interaction.
    const first = getCwdSwitchDecision({
      nextCwd: '/project-b',
      requestedCwd: '/project-a',
      dismissedCwd: null,
      currentTerminalCwd: '/project-a',
      hasUserInteracted: false,
      hasPendingInput: false,
    });
    expect(first).toBe('auto');

    const second = getCwdSwitchDecision({
      nextCwd: '/project-c',
      requestedCwd: '/project-b',
      dismissedCwd: null,
      currentTerminalCwd: '/project-b',
      hasUserInteracted: true,
      hasPendingInput: false,
    });
    expect(second).toBe('prompt');
  });

  it('keeps pane-local state isolated in split view scenarios', () => {
    const paneADecision = getCwdSwitchDecision({
      nextCwd: '/project-a-next',
      requestedCwd: '/project-a',
      dismissedCwd: null,
      currentTerminalCwd: '/project-a',
      hasUserInteracted: true,
      hasPendingInput: false,
    });
    const paneBDecision = getCwdSwitchDecision({
      nextCwd: '/project-b-next',
      requestedCwd: '/project-b',
      dismissedCwd: null,
      currentTerminalCwd: '/project-b',
      hasUserInteracted: false,
      hasPendingInput: false,
    });

    expect(paneADecision).toBe('prompt');
    expect(paneBDecision).toBe('auto');
  });
});

describe('buildCdCommand', () => {
  it('quotes paths with spaces', () => {
    expect(buildCdCommand('/Users/me/My Project')).toBe('cd "/Users/me/My Project"\n');
  });

  it('escapes double quotes in paths', () => {
    expect(buildCdCommand('/tmp/my "quoted" folder')).toBe('cd "/tmp/my \\"quoted\\" folder"\n');
  });

  it('escapes shell-special characters like dollar signs and backticks', () => {
    expect(buildCdCommand('/tmp/$HOME and `pwd`')).toBe('cd "/tmp/\\$HOME and \\`pwd\\`"\n');
  });
});

describe('resolveExternalTerminalPath', () => {
  it('prefers current terminal cwd over pending switch', () => {
    expect(resolveExternalTerminalPath('/current/cwd', '/pending/cwd')).toBe('/current/cwd');
  });

  it('falls back to pending cwd when current is unavailable', () => {
    expect(resolveExternalTerminalPath(null, '/pending/cwd')).toBe('/pending/cwd');
  });

  it('returns null when no path is available', () => {
    expect(resolveExternalTerminalPath(null, null)).toBeNull();
  });
});
