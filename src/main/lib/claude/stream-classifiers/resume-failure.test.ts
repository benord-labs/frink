import { describe, expect, it } from 'vitest';
import { isResumeFailureText } from './resume-failure';

describe('isResumeFailureText', () => {
  it('matches session not found', () => {
    expect(isResumeFailureText('Session not found')).toBe(true);
  });

  it('matches invalid session', () => {
    expect(isResumeFailureText('Invalid session id')).toBe(true);
  });

  it('matches unknown session', () => {
    expect(isResumeFailureText('Unknown session')).toBe(true);
  });

  it('matches no conversation found (Claude Code CLI resume)', () => {
    expect(
      isResumeFailureText(
        'Claude Code returned an error result: No conversation found with session ID: 722bd11e-7add-44f9-a221-bc5be401a469',
      ),
    ).toBe(true);
  });

  it('matches resume + session substring combo', () => {
    expect(isResumeFailureText('Failed to resume session xyz')).toBe(true);
  });

  it('matches cannot resume phrasing', () => {
    expect(isResumeFailureText('Cannot resume session abc')).toBe(true);
  });

  it('returns false for benign prose that mentions resume and session', () => {
    expect(
      isResumeFailureText(
        'User can resume work after reconnecting; session state is preserved on the server.',
      ),
    ).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    expect(isResumeFailureText('rate limit exceeded')).toBe(false);
    expect(isResumeFailureText('')).toBe(false);
  });
});
