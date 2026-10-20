// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { formatWaitingSince } from '../utils/format-time';
import {
  admissionGroup,
  admissionRemovalCopy,
  admissionWaitCopy,
  oldestWaitingNote,
} from './admission-wait-copy';

describe('admissionGroup', () => {
  it('keeps resumes in their own group whatever the run-first flag says', () => {
    expect(admissionGroup({ priorityClass: 'resume', runFirst: false })).toBe('resume');
    expect(admissionGroup({ priorityClass: 'resume', runFirst: true })).toBe('resume');
    expect(admissionGroup({ priorityClass: 'start', runFirst: true })).toBe('first');
    expect(admissionGroup({ priorityClass: 'start', runFirst: false })).toBe('start');
  });
});

describe('admissionWaitCopy', () => {
  it('names the group a waiting row belongs to', () => {
    expect(admissionWaitCopy('resume', false).statusLabel).toBe('Queued to resume');
    expect(admissionWaitCopy('first', false)).toEqual({
      description: 'Waiting to start first',
      statusLabel: 'Queued to start first',
    });
    expect(admissionWaitCopy('start', false).statusLabel).toBe('Queued to start');
  });

  it('says on hold while paused and claims nothing while the setting is unknown', () => {
    expect(admissionWaitCopy('first', true).statusLabel).toBe('On hold');
    expect(admissionWaitCopy('first', null).statusLabel).toBe('Queued');
  });
});

describe('admissionRemovalCopy', () => {
  it('describes a run-first start exactly like any other start', () => {
    const start = admissionRemovalCopy({ isBatchMember: true, priorityClass: 'start' });
    expect(start).toMatch(/queued run is cancelled.*one failed member of its batch stage/);
    expect(admissionRemovalCopy({ isBatchMember: false, priorityClass: 'resume' })).toMatch(
      /^The finished run stays as it is/,
    );
  });
});

describe('oldestWaitingNote', () => {
  it('uses the earliest request, not the first row', () => {
    const oldest = new Date('2026-10-13T08:00:00Z');
    expect(
      oldestWaitingNote([
        { requestedAt: new Date('2026-10-15T08:00:00Z') },
        { requestedAt: oldest },
      ]),
    ).toBe(`Oldest waiting since ${formatWaitingSince(oldest)}`);
    expect(oldestWaitingNote([])).toBeUndefined();
  });
});
