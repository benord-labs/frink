import { describe, expect, it } from 'vitest';
import { elapsedShare, orderedWindowKeys, paceOf, windowDurationMins, windowLabel } from './index';

describe('windowLabel', () => {
  it('uses the friendly label for a known window key', () => {
    expect(windowLabel('five_hour')).toBe('Session (5hr)');
    expect(windowLabel('seven_day')).toBe('Weekly (7 day)');
  });

  it('humanizes an unknown key (e.g. a newer window the SDK adds)', () => {
    expect(windowLabel('seven_day_fable')).toBe('Seven Day Fable');
  });
});

describe('orderedWindowKeys', () => {
  it('orders known keys by display order regardless of input order', () => {
    expect(orderedWindowKeys(['seven_day', 'five_hour', 'seven_day_opus'])).toEqual([
      'five_hour',
      'seven_day',
      'seven_day_opus',
    ]);
  });

  it('appends unknown keys after the known ones, preserving their input order', () => {
    expect(orderedWindowKeys(['weekly_fable', 'five_hour'])).toEqual(['five_hour', 'weekly_fable']);
  });

  it('returns only the present keys', () => {
    expect(orderedWindowKeys(['seven_day'])).toEqual(['seven_day']);
  });
});

const HOUR = 60 * 60_000;
const NOW = 1_700_000_000_000;

describe('rate-limit window helpers', () => {
  it('labels a model-scoped weekly window by its model name', () => {
    expect(windowLabel('model_scoped:Fable')).toBe('Weekly (Fable)');
  });

  it('knows the rolling length of session and weekly windows only', () => {
    expect(windowDurationMins('five_hour')).toBe(300);
    expect(windowDurationMins('seven_day_opus')).toBe(10_080);
    expect(windowDurationMins('model_scoped:Fable')).toBe(10_080);
    expect(windowDurationMins('overage')).toBeNull();
  });

  it('measures how much of the window clock has elapsed', () => {
    const win = { utilization: 50, resetsAt: NOW + 2.5 * HOUR, status: 'allowed' as const };
    expect(elapsedShare('five_hour', win, NOW)).toBe(0.5);
    expect(elapsedShare('overage', win, NOW)).toBeNull();
  });

  it('reports pace against even spending, with a ±5 point band', () => {
    const at = (utilization: number) => ({
      utilization,
      resetsAt: NOW + 2.5 * HOUR,
      status: 'allowed' as const,
    });
    expect(paceOf('five_hour', at(70), NOW)).toBe('ahead');
    expect(paceOf('five_hour', at(53), NOW)).toBe('on');
    expect(paceOf('five_hour', at(20), NOW)).toBe('under');
    expect(paceOf('five_hour', { ...at(20), resetsAt: null }, NOW)).toBeNull();
  });
});
