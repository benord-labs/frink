import { describe, expect, it } from 'vitest';
import {
  agentsChatComposerShellClass,
  agentsChatUserBubbleShellClass,
  COMPOSER_ACTION_ROW_CLASS,
  COMPOSER_CONTROL_CLASS,
  COMPOSER_CONTROL_LABEL_CLASS,
  COMPOSER_MODEL_CONTROL_CLASS,
  COMPOSER_MODEL_DETAIL_CLASS,
  COMPOSER_MODEL_LABEL_CLASS,
} from './chat-composer-shell-classes';

/** The container width, in rem, below which a tier class hides its element. */
function hideTierRem(className: string): number {
  const match = className.match(/@max-\[([\d.]+)rem\]\/composer:hidden/);
  if (!match) throw new Error(`no hide tier in "${className}"`);
  return Number(match[1]);
}

// happy-dom has no layout, so this pins the contract rather than the rendered result: the row
// shared by both composers never wraps its icon controls into a second line.
describe('composer footer contract', () => {
  it('keeps the toolbar row on one line and clips instead of overlapping', () => {
    expect(COMPOSER_ACTION_ROW_CLASS).toMatch(/\bflex-nowrap\b/);
    expect(COMPOSER_ACTION_ROW_CLASS).toMatch(/\boverflow-hidden\b/);
    expect(COMPOSER_ACTION_ROW_CLASS).not.toMatch(/\bflex-wrap\b/);
  });

  it('keeps the model name after every other label: control labels, then tier, then name', () => {
    const controlLabels = hideTierRem(COMPOSER_CONTROL_LABEL_CLASS);
    const modelDetail = hideTierRem(COMPOSER_MODEL_DETAIL_CLASS);
    const modelName = hideTierRem(COMPOSER_MODEL_LABEL_CLASS);
    expect(controlLabels).toBeGreaterThan(modelDetail);
    expect(modelDetail).toBeGreaterThan(modelName);
    expect(COMPOSER_MODEL_CONTROL_CLASS).toContain(`@max-[${modelName}rem]/composer:w-7`);
    expect(COMPOSER_MODEL_CONTROL_CLASS).not.toMatch(/(^|\s)shrink-0\b/);
  });

  it('insets the icon 6px in both states, so it never jumps when a label appears', () => {
    for (const control of [COMPOSER_CONTROL_CLASS, COMPOSER_MODEL_CONTROL_CLASS]) {
      expect(control).toMatch(/(^|\s)pl-1\.5(\s|$)/);
      expect(control).toMatch(/composer:w-7\b/);
      expect(control).toMatch(/composer:px-0\b/);
    }
  });
});

describe('chat surfaces', () => {
  it('put user bubbles and the composer on the glass material with its blur', () => {
    for (const surface of [
      agentsChatUserBubbleShellClass(),
      agentsChatComposerShellClass(false, false),
    ])
      expect(surface).toMatch(/(^|\s)glass-float(\s|$)/);
  });

  // The composer, flow strip, paused bar, question card and park card all hold the composer's slot.
  it('marks the composer surface as a slot surface, so a stacked card squares its top', () => {
    expect(agentsChatComposerShellClass(false, false)).toMatch(/(^|\s)composer-slot-surface(\s|$)/);
  });

  it('draws the drop and focus rings on the composer rim, with no offset band', () => {
    for (const [isDragOver, isFocused] of [
      [true, false],
      [false, true],
    ]) {
      const shell = agentsChatComposerShellClass(isDragOver, isFocused);
      expect(shell).toMatch(/(^|\s)ring-2(\s|$)/);
      expect(shell).not.toMatch(/ring-offset/);
    }
  });
});
