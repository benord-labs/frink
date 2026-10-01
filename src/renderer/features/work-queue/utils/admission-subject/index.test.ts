import { describe, expect, it } from 'vitest';
import { admissionSubject, admissionTrigger } from './index';

const shortcutEnvelope = {
  source: 'shortcut',
  sourceAccountId: 'acct-1',
  eventType: 'story_assigned',
  triggeredBy: {},
  timestamp: '2026-09-15T20:32:41.546Z',
  fullContent: {
    primary_id: 3377,
    actions: [{ entity_type: 'story', name: 'Un-ignore the atoms barrel', app_url: '' }],
    references: [],
  },
};

describe('admissionSubject', () => {
  it('titles a webhook-triggered run from its trigger summary', () => {
    expect(admissionSubject(shortcutEnvelope, false)).toBe('Un-ignore the atoms barrel');
  });

  it('titles a batch stage member from its item label', () => {
    expect(admissionSubject({ ticketId: '3377', label: '#3377 atoms/index.ts' }, true)).toBe(
      '#3377 atoms/index.ts',
    );
  });

  it('never reads a batch item as a trigger envelope, even when it is shaped like one', () => {
    const itemLikeEnvelope = { ...shortcutEnvelope, label: '#3377 atoms/index.ts' };
    expect(admissionSubject(itemLikeEnvelope, true)).toBe('#3377 atoms/index.ts');
    expect(admissionSubject(shortcutEnvelope, true)).toBeNull();
    expect(admissionTrigger(shortcutEnvelope, true)).toBeNull();
    expect(admissionTrigger(shortcutEnvelope, false)).not.toBeNull();
  });

  it('ignores a label on a run that is not a batch member', () => {
    expect(admissionSubject({ label: '#3377 atoms/index.ts' }, false)).toBeNull();
  });

  it('returns null when the run has nothing recognisable to show', () => {
    expect(admissionSubject(null, false)).toBeNull();
    expect(admissionSubject(null, true)).toBeNull();
    expect(
      admissionSubject({ _frinkTrigger: 'schedule_trigger', cronExpression: '0 9 * * *' }, false),
    ).toBeNull();
    expect(admissionSubject({ label: '   ' }, true)).toBeNull();
    expect(
      admissionSubject(
        {
          ...shortcutEnvelope,
          fullContent: { actions: [{ entity_type: 'story' }] },
        },
        false,
      ),
    ).toBeNull();
  });
});
