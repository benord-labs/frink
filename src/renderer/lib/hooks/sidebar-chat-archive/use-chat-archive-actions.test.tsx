// @vitest-environment happy-dom
import { cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useArchiveWindowEvents, useChatArchive } from './use-chat-archive-actions';

type ProbeProps = {
  focusedChatId: string | null;
  isChatCovered: boolean;
  archiveSingleChat: (chatId: string) => Promise<void>;
  /** Receives every render's handler, so a test can press one captured before a re-render. */
  onHandler: (press: () => void) => void;
};

function Probe({ focusedChatId, isChatCovered, archiveSingleChat, onHandler }: ProbeProps) {
  onHandler(
    useArchiveWindowEvents({
      focusedChatId,
      isChatCovered,
      archiveSingleChat,
      restoreChat: async () => {},
    }),
  );
  return null;
}

describe('useArchiveWindowEvents', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('archives the chat focused now, even through a handler captured before focus moved', async () => {
    const archiveSingleChat = vi.fn(async () => {});
    const handlers: Array<() => void> = [];
    const onHandler = (press: () => void) => handlers.push(press);
    const props = { isChatCovered: false, archiveSingleChat, onHandler };
    const { rerender } = render(<Probe {...props} focusedChatId="chat-old" />);
    const staleHandler = handlers[0];

    rerender(<Probe {...props} focusedChatId="chat-new" />);
    staleHandler?.();

    await waitFor(() => expect(archiveSingleChat).toHaveBeenCalledWith('chat-new'));
    expect(archiveSingleChat).not.toHaveBeenCalledWith('chat-old');
  });

  it('archives nothing through a handler captured before an overlay covered the chat', async () => {
    const archiveSingleChat = vi.fn(async () => {});
    const handlers: Array<() => void> = [];
    const onHandler = (press: () => void) => handlers.push(press);
    const props = { focusedChatId: 'chat-a', archiveSingleChat, onHandler };
    const { rerender } = render(<Probe {...props} isChatCovered={false} />);
    const staleHandler = handlers[0];

    rerender(<Probe {...props} isChatCovered={true} />);
    staleHandler?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(archiveSingleChat).not.toHaveBeenCalled();
  });

  it('lets the shortcut archive again after a failed archive', async () => {
    const errorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    const archiveSingleChat = vi.fn(async () => {});
    archiveSingleChat.mockRejectedValueOnce(new Error('archive boom'));
    const handlers: Array<() => void> = [];
    const onHandler = (press: () => void) => handlers.push(press);
    render(
      <Probe
        focusedChatId="chat-a"
        isChatCovered={false}
        archiveSingleChat={archiveSingleChat}
        onHandler={onHandler}
      />,
    );

    handlers[0]?.();
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    handlers[0]?.();

    await waitFor(() => expect(archiveSingleChat).toHaveBeenCalledTimes(2));
  });
});

describe('useChatArchive', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('archives straight away and toasts the reason when archive refuses', async () => {
    const errorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    const archiveSingleChat = vi.fn(async () => {});
    archiveSingleChat.mockRejectedValueOnce(
      new Error("Could not stop this chat's task, so the chat was not archived."),
    );
    const { result } = renderHook(() => useChatArchive(archiveSingleChat));

    await result.current('chat-a');

    expect(archiveSingleChat).toHaveBeenCalledWith('chat-a');
    expect(errorSpy).toHaveBeenCalledWith('Failed to archive chat', {
      description: "Could not stop this chat's task, so the chat was not archived.",
    });
  });
});
