import { describe, expect, it } from 'vitest';
import { applyApprovedPlanContextToPrompt } from './approved-plan-prompt';

const approved = { planText: 'Ship the migration in two steps' };

describe('applyApprovedPlanContextToPrompt', () => {
  it('prepends the approved plan to a normal prompt', () => {
    const out = applyApprovedPlanContextToPrompt('Implement now', approved);
    expect(out).toContain('Ship the migration in two steps');
    expect(out.endsWith('Implement now')).toBe(true);
  });

  it('returns /compact bare so it stays at prompt position 0', () => {
    // The composer already dropped the user's attached context on the assumption this is a
    // command; prepending here would make it an ordinary message and lose that context for nothing.
    expect(applyApprovedPlanContextToPrompt('/compact', approved)).toBe('/compact');
  });

  it('still prepends for a prompt that only mentions the command', () => {
    expect(applyApprovedPlanContextToPrompt('please run /compact', approved)).toContain(
      'Ship the migration in two steps',
    );
  });

  it('returns the prompt unchanged with no approved plan', () => {
    expect(applyApprovedPlanContextToPrompt('Implement now', undefined)).toBe('Implement now');
  });
});
