// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { formatWaitingSince } from '../utils/format-time';
import {
  admissionGroup,
  admissionRemovalCopy,
  admissionWaitCopy,
  oldestWaitingNote,
  recoveryWaitToast,
} from './admission-wait-copy';

// A repeat click must still say something: it used to show the same "Queued to resume" toast.
describe('recoveryWaitToast', () => {
  it('confirms a wait for a slot, including a repeat click, and stays quiet once resumed', () => {
    expect(recoveryWaitToast('queued')).toBe('Queued to resume');
    expect(recoveryWaitToast('already-queued')).toBe('Already queued to resume');
    expect(recoveryWaitToast('resumed')).toBeNull();
  });
});

describe('admissionGroup', () => {
  it('keeps resumes in their own group whatever the run-first flag says', () => {
    expect(admissionGroup({ priorityClass: 'resume', runFirst: false })).toBe('resume');
    expect(admissionGroup({ priorityClass: 'resume', runFirst: true })).toBe('resume');
    expect(admissionGroup({ priorityClass: 'start', runFirst: true })).toBe('priority');
    expect(admissionGroup({ priorityClass: 'start', runFirst: false })).toBe('start');
  });
});

describe('admissionWaitCopy', () => {
  it('names the group a waiting row belongs to', () => {
    expect(admissionWaitCopy('resume', false).statusLabel).toBe('Queued to resume');
    expect(admissionWaitCopy('priority', false)).toEqual({
      description: 'Waiting in the priority queue',
      statusLabel: 'Queued with priority',
    });
    expect(admissionWaitCopy('start', false).statusLabel).toBe('Queued to start');
  });

  it('says on hold while paused and claims nothing while the setting is unknown', () => {
    expect(admissionWaitCopy('priority', true).statusLabel).toBe('On hold');
    expect(admissionWaitCopy('priority', null).statusLabel).toBe('Queued');
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
