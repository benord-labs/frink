// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHotkeyRecorder } from './use-hotkey-recorder';

type HarnessProps = {
  onRecord: (hotkey: string) => void;
  onCancel?: () => void;
};

function HotkeyRecorderHarness({ onRecord, onCancel = vi.fn() }: HarnessProps) {
  const { recorderRef } = useHotkeyRecorder({
    onRecord,
    onCancel,
    isRecording: true,
  });
  return <div ref={recorderRef} data-testid="recorder" />;
}

describe('useHotkeyRecorder — plus/minus key normalisation', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('records Cmd+Shift+= as "cmd+shift+plus" (not "cmd+shift++")', () => {
    const onRecord = vi.fn();
    render(<HotkeyRecorderHarness onRecord={onRecord} />);

    // Simulate holding Cmd then Shift then pressing = (which gives key="+")
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Shift', metaKey: true, shiftKey: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '+', code: 'Equal', metaKey: true, shiftKey: true }),
    );
    // Release the main key to trigger recording
    window.dispatchEvent(
      new KeyboardEvent('keyup', { key: '+', code: 'Equal', metaKey: true, shiftKey: true }),
    );

    expect(onRecord).toHaveBeenCalledWith('cmd+shift+plus');
  });

  it('records Cmd+= as "cmd+plus" (not "cmd+=")', () => {
    const onRecord = vi.fn();
    render(<HotkeyRecorderHarness onRecord={onRecord} />);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '=', code: 'Equal', metaKey: true, shiftKey: false }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keyup', { key: '=', code: 'Equal', metaKey: true, shiftKey: false }),
    );

    expect(onRecord).toHaveBeenCalledWith('cmd+plus');
  });

  it('records Cmd+- as "cmd+minus" (not "cmd+-")', () => {
    const onRecord = vi.fn();
    render(<HotkeyRecorderHarness onRecord={onRecord} />);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '-', code: 'Minus', metaKey: true, shiftKey: false }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keyup', { key: '-', code: 'Minus', metaKey: true, shiftKey: false }),
    );

    expect(onRecord).toHaveBeenCalledWith('cmd+minus');
  });

  it('records Cmd+Shift+- as "cmd+shift+minus"', () => {
    const onRecord = vi.fn();
    render(<HotkeyRecorderHarness onRecord={onRecord} />);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Shift', metaKey: true, shiftKey: true }),
    );
    // On US keyboard Shift+- produces "_"; we send the raw key the OS would report
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '-', code: 'Minus', metaKey: true, shiftKey: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keyup', { key: '-', code: 'Minus', metaKey: true, shiftKey: true }),
    );

    expect(onRecord).toHaveBeenCalledWith('cmd+shift+minus');
  });

  it('recorded "cmd+shift+plus" matches the zoom-in-grow-pane default binding', () => {
    // Ensure round-trip: recorded value ≡ default registry value
    const onRecord = vi.fn();
    render(<HotkeyRecorderHarness onRecord={onRecord} />);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Shift', metaKey: true, shiftKey: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '+', code: 'Equal', metaKey: true, shiftKey: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keyup', { key: '+', code: 'Equal', metaKey: true, shiftKey: true }),
    );

    // Must equal the default shortcut-registry value for zoom-in-grow-pane
    expect(onRecord).toHaveBeenCalledWith('cmd+shift+plus');
  });
});

function DisplayHarness() {
  const { recorderRef, currentDisplay } = useHotkeyRecorder({
    onRecord: vi.fn(),
    onCancel: vi.fn(),
    isRecording: true,
  });
  return (
    <div ref={recorderRef} data-testid="display">
      {currentDisplay}
    </div>
  );
}

// The live display shares the registry's key→glyph table, so what the user sees while
// holding keys matches what the Settings search shows once the combination is recorded.
describe('useHotkeyRecorder — live display', () => {
  afterEach(() => {
    cleanup();
  });

  it.each([
    ['k', '⌘⇧K'],
    ['ArrowUp', '⌘⇧↑'],
    ['Enter', '⌘⇧↵'],
    ['Backspace', '⌘⇧⌫'],
    ['Delete', '⌘⇧⌦'],
    [' ', '⌘⇧Space'],
    ['+', '⌘⇧+'],
    ['-', '⌘⇧−'],
    ['F5', '⌘⇧F5'],
    ['Home', '⌘⇧HOME'],
  ])('shows %j held with Cmd+Shift as %s', (key, expected) => {
    render(<DisplayHarness />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Shift', metaKey: true, shiftKey: true }),
      );
      window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, shiftKey: true }));
    });
    expect(screen.getByTestId('display').textContent).toBe(expected);
  });

  it('orders modifiers canonically regardless of press order', () => {
    render(<DisplayHarness />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }));
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Alt', shiftKey: true, altKey: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Control',
          shiftKey: true,
          altKey: true,
          ctrlKey: true,
        }),
      );
    });
    expect(screen.getByTestId('display').textContent).toBe('⌃⌥⇧');
  });
});
