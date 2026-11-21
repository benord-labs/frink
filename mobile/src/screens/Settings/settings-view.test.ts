import { describe, expect, it } from 'vitest';
import {
  computerStatus,
  forgetPrompt,
  notificationsNote,
  sourceLine,
  statusLine,
} from './settings-view';

describe('computerStatus', () => {
  it('reads a healthy poll as connected', () => {
    expect(computerStatus({ data: { executionReady: true } })).toEqual({
      label: 'Connected',
      tone: 'live',
    });
  });

  it('asks for Frink to be opened when the computer answers but cannot run chats', () => {
    expect(computerStatus({ data: { executionReady: false } })).toEqual({
      label: 'Frink isn’t open on your computer',
      tone: 'attention',
    });
  });

  it('prefers an unreachable computer over stale data from an earlier poll', () => {
    expect(
      computerStatus({ data: { executionReady: true }, error: 'offline', errorStatus: 0 }),
    ).toMatchObject({
      label: 'Offline',
      detail: expect.stringMatching(/awake and online/),
      tone: 'quiet',
    });
  });

  it('does not blame the network when the computer answered with an error', () => {
    const status = computerStatus({
      data: { executionReady: true },
      error: 'boom',
      errorStatus: 500,
    });
    expect(status).toMatchObject({ label: 'Having trouble', tone: 'attention' });
    expect(status.detail).not.toMatch(/awake and online/);
  });

  it('waits quietly for the first answer', () => {
    expect(computerStatus({})).toEqual({ label: 'Checking…', tone: 'quiet' });
  });
});

describe('statusLine', () => {
  it('says the state alone when there is nothing to do about it', () => {
    expect(statusLine({ label: 'Connected', tone: 'live' })).toBe('Connected');
  });

  it('follows the state with what to do', () => {
    expect(statusLine(computerStatus({ error: 'offline', errorStatus: 0 }))).toBe(
      'Offline. Keep Frink open and your computer awake and online.',
    );
  });
});

describe('forgetPrompt', () => {
  it('names the computer being forgotten and how to revoke it there', () => {
    const prompt = forgetPrompt('Studio Mac');
    expect(prompt.title).toBe('Forget Studio Mac?');
    expect(prompt.message).toMatch(
      /^This iPhone stops showing Studio Mac until you pair it again\./,
    );
    expect(prompt.message).toMatch(/Paired phones in Frink on that computer/);
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

describe('notificationsNote', () => {
  const quiet = { denied: false, refused: false, error: null };

  it('says what alerts carry when nothing is wrong', () => {
    expect(notificationsNote(quiet)).toEqual({
      text: 'Tells you when a chat needs you or finishes. Your prompts and code stay on your computer.',
      tone: 'muted',
      openSettings: false,
    });
  });

  it('points to iPhone Settings when alerts are refused there', () => {
    expect(notificationsNote({ ...quiet, denied: true })).toMatchObject({
      text: expect.stringMatching(/^Alerts are off for Frink in iPhone Settings/),
      openSettings: true,
    });
  });

  it('points to iPhone Settings when Live Activities are refused there', () => {
    expect(notificationsNote({ ...quiet, refused: true })).toMatchObject({
      text: expect.stringMatching(/^Live Activities are off for Frink in iPhone Settings/),
      openSettings: true,
    });
  });

  it('puts a failed update first, in red, over every other note', () => {
    expect(notificationsNote({ denied: true, refused: true, error: 'Try again.' })).toEqual({
      text: 'Try again.',
      tone: 'danger',
      openSettings: false,
    });
  });
});
