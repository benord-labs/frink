import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeaveGuard, forceReload, LEAVE_ACK_TIMEOUT_MS } from './leave-guard';

function setup() {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  const ipc = new EventEmitter();
  const webContents = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    isDestroyed: () => false,
    isCrashed: vi.fn(() => false),
  });
  const window = Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
  });
  const guard = createLeaveGuard({ app, ipc });
  guard.attach(window);
  const fromRenderer = (channel: string, value?: boolean) =>
    ipc.emit(channel, { sender: webContents }, value);
  /** Emits the window's close as Electron does; true when a listener vetoed it. */
  const close = () => {
    const preventDefault = vi.fn();
    window.emit('close', { preventDefault });
    return preventDefault.mock.calls.length > 0;
  };
  const quit = () => {
    app.emit('before-quit');
    return close();
  };
  return { app, ipc, guard, window, webContents, fromRenderer, close, quit };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('leave guard', () => {
  it('lets a quit through without asking when no tab is unsaved', () => {
    const { quit, webContents } = setup();
    expect(quit()).toBe(false);
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it('holds a quit with an unsaved tab and quits again once the renderer confirms', () => {
    const { app, quit, close, webContents, window, fromRenderer } = setup();
    fromRenderer('leave-guard:set-unsaved', true);

    expect(quit()).toBe(true);
    expect(webContents.send).toHaveBeenCalledWith('leave-guard:request', 'quit');
    expect(window.focus).toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();

    fromRenderer('leave-guard:ack');
    fromRenderer('leave-guard:confirm');
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(close()).toBe(false);
  });

  it('keeps the window after Cancel, and the next close asks again', () => {
    const { close, webContents, window, fromRenderer } = setup();
    fromRenderer('leave-guard:set-unsaved', true);

    expect(close()).toBe(true);
    expect(webContents.send).toHaveBeenLastCalledWith('leave-guard:request', 'close');
    fromRenderer('leave-guard:ack');
    fromRenderer('leave-guard:cancel');
    vi.advanceTimersByTime(LEAVE_ACK_TIMEOUT_MS);
    expect(window.close).not.toHaveBeenCalled();

    expect(close()).toBe(true);
    expect(webContents.send).toHaveBeenCalledTimes(2);
  });

  it('quits anyway when a hung renderer never acknowledges', () => {
    const { app, quit, fromRenderer } = setup();
    fromRenderer('leave-guard:set-unsaved', true);
    quit();
    vi.advanceTimersByTime(LEAVE_ACK_TIMEOUT_MS);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('does not wait on a renderer that crashed', () => {
    const { close, webContents, fromRenderer } = setup();
    fromRenderer('leave-guard:set-unsaved', true);
    webContents.isCrashed.mockReturnValue(true);
    expect(close()).toBe(false);
  });

  it('drops a pending leave when its window closes before the renderer answers', () => {
    const { close, webContents, window, fromRenderer } = setup();
    fromRenderer('leave-guard:set-unsaved', true);
    expect(close()).toBe(true);
    // The renderer crashed under the prompt, so the next close went through.
    webContents.isCrashed.mockReturnValue(true);
    expect(close()).toBe(false);
    window.emit('closed');

    // The hung-renderer timer must not call close() on the destroyed window.
    vi.advanceTimersByTime(LEAVE_ACK_TIMEOUT_MS);
    expect(window.close).not.toHaveBeenCalled();
  });

  it('forgets the unsaved flag when the page navigates away', () => {
    const { close, webContents, fromRenderer } = setup();
    fromRenderer('leave-guard:set-unsaved', true);
    webContents.emit('did-navigate');
    expect(close()).toBe(false);
  });

  it('drops a prompt the page navigated away from, so a later close still asks', () => {
    const { quit, close, webContents, fromRenderer } = setup();
    fromRenderer('leave-guard:set-unsaved', true);
    quit();
    fromRenderer('leave-guard:ack');
    webContents.emit('did-navigate');

    fromRenderer('leave-guard:set-unsaved', true);
    expect(close()).toBe(true);
    expect(webContents.send).toHaveBeenLastCalledWith('leave-guard:request', 'close');
  });

  it('keeps asking when a navigation starts but never commits (e.g. a 204)', () => {
    const { close, webContents, fromRenderer } = setup();
    fromRenderer('leave-guard:set-unsaved', true);
    webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(close()).toBe(true);
  });

  it('ignores answers from any other webContents', () => {
    const { app, ipc, quit, fromRenderer } = setup();
    fromRenderer('leave-guard:set-unsaved', true);
    quit();
    fromRenderer('leave-guard:ack');
    // e.g. an artifact preview window
    ipc.emit('leave-guard:confirm', { sender: {} });
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('reloads at once when clean, and after confirm when unsaved, asking again on the next close', () => {
    const { guard, close, webContents, fromRenderer } = setup();
    const reload = vi.fn();
    guard.requestLeave('reload', reload);
    expect(reload).toHaveBeenCalledTimes(1);

    fromRenderer('leave-guard:set-unsaved', true);
    guard.requestLeave('reload', reload);
    expect(webContents.send).toHaveBeenCalledWith('leave-guard:request', 'reload');
    expect(reload).toHaveBeenCalledTimes(1);
    fromRenderer('leave-guard:confirm');
    expect(reload).toHaveBeenCalledTimes(2);
    expect(close()).toBe(true);
  });

  it('keeps a pending quit when a close is asked for under its prompt', () => {
    const { app, quit, close, window, fromRenderer } = setup();
    fromRenderer('leave-guard:set-unsaved', true);
    quit();
    close();
    fromRenderer('leave-guard:confirm');
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(window.close).not.toHaveBeenCalled();
  });

  it('asks again about edits made after a confirmed update that never installed', () => {
    const { guard, close, fromRenderer } = setup();
    fromRenderer('leave-guard:set-unsaved', true);
    guard.requestLeave('update', () => {});
    // Save wrote every tab, then the installer did nothing.
    fromRenderer('leave-guard:set-unsaved', false);
    fromRenderer('leave-guard:confirm');

    fromRenderer('leave-guard:set-unsaved', true);
    expect(close()).toBe(true);
  });
});

describe('Force Reload', () => {
  const windowWith = () => ({ webContents: { reloadIgnoringCache: vi.fn() } });

  it('reloads a focused artifact preview itself, leaving the main window alone', () => {
    const main = windowWith();
    const preview = windowWith();
    const guard = { requestLeave: vi.fn() };

    forceReload(main, preview, guard);

    expect(preview.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(main.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
    expect(guard.requestLeave).not.toHaveBeenCalled();
  });

  it('reloads the main window only once the guard lets it go', () => {
    const main = windowWith();
    const guard = { requestLeave: vi.fn() };

    forceReload(main, main, guard);
    expect(main.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
    guard.requestLeave.mock.calls[0][1]();

    expect(guard.requestLeave).toHaveBeenCalledWith('reload', expect.any(Function));
    expect(main.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
  });
});
