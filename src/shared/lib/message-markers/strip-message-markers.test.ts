import { describe, expect, it } from 'vitest';
import { stripMessageMarkers, stripMessageMarkersToOneLine } from './strip-message-markers';

describe('stripMessageMarkers', () => {
  it('removes trigger and task bubble markers', () => {
    expect(stripMessageMarkers('<!--TRIGGER_BUBBLE:{"uiData":{}}-->\n\nreview the PR')).toBe(
      'review the PR',
    );
    expect(stripMessageMarkers('<!--TASK_BUBBLE:{"id":"1"}-->')).toBe('');
  });

  it('leaves an unmarked message untouched apart from trimming', () => {
    expect(stripMessageMarkers('  a typed message  ')).toBe('a typed message');
  });

  it('does not swallow an ordinary HTML comment', () => {
    expect(stripMessageMarkers('<!-- a note --> keep me')).toBe('<!-- a note --> keep me');
  });

  it('stops at the first terminator so trailing prose survives', () => {
    expect(stripMessageMarkers('<!--TASK_BUBBLE:{}--> body <!--TASK_BUBBLE:{}--> tail')).toBe(
      'body  tail',
    );
  });
});

describe('stripMessageMarkersToOneLine', () => {
  it('collapses the remaining body onto one line for naming prompts', () => {
    expect(stripMessageMarkersToOneLine('<!--TRIGGER_BUBBLE:{}-->\n\nreview\nthe PR')).toBe(
      'review the PR',
    );
  });
});
