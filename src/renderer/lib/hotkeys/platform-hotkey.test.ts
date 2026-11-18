// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isPrimaryChord, isFieldReservedChord } from './platform-hotkey';

describe('isFieldReservedChord', () => {
  const terminal = document.createElement('div');
  terminal.className = 'xterm';
  const input = terminal.appendChild(document.createElement('textarea'));
  const outside = document.createElement('textarea');

  it('reserves plain Ctrl chords and Ctrl+Shift+V paste inside the terminal off Mac', () => {
    expect(isFieldReservedChord('ctrl+b', input, false)).toBe(true);
    expect(isFieldReservedChord('ctrl+shift+v', input, false)).toBe(true);
    expect(isFieldReservedChord('ctrl+shift+p', input, false)).toBe(false);
  });

  it('reserves only Ctrl+Shift+V paste in other text fields, and nothing on Mac', () => {
    expect(isFieldReservedChord('ctrl+b', outside, false)).toBe(false);
    expect(isFieldReservedChord('ctrl+shift+v', outside, false)).toBe(true);
    expect(isFieldReservedChord('ctrl+shift+v', document.createElement('div'), false)).toBe(false);
    expect(isFieldReservedChord('ctrl+b', input, true)).toBe(false);
  });
});

describe('isPrimaryChord', () => {
  const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
    const e = new KeyboardEvent('keydown', { key: 'j', bubbles: true, ...init });
    let result: boolean | undefined;
    target.addEventListener(
      'keydown',
      (ev) => {
        if (ev instanceof KeyboardEvent) result = isPrimaryChord(ev, false);
      },
      { once: true },
    );
    target.dispatchEvent(e);
    return result;
  };

  it('is Cmd on Mac and Ctrl elsewhere, never both', () => {
    expect(isPrimaryChord(new KeyboardEvent('keydown', { key: 'j', metaKey: true }), true)).toBe(
      true,
    );
    expect(isPrimaryChord(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }), true)).toBe(
      false,
    );
    expect(press({ ctrlKey: true })).toBe(true);
    expect(press({ metaKey: true })).toBe(false);
    expect(press({ ctrlKey: true, metaKey: true })).toBe(false);
  });

  it('yields plain Ctrl chords typed in the terminal to the shell, but not Ctrl+Shift ones', () => {
    const terminal = document.body.appendChild(document.createElement('div'));
    terminal.className = 'xterm';
    const input = terminal.appendChild(document.createElement('textarea'));
    expect(press({ ctrlKey: true }, input)).toBe(false);
    expect(press({ ctrlKey: true, shiftKey: true, key: 'J' }, input)).toBe(true);
    terminal.remove();
  });
});
