import { useEffect, useMemo, useRef, useState } from 'react';
import type { MobileMessage } from '../../../../src/shared/types/remote/mobile';
import { useConnection } from '../../lib/connection';

// Earlier pages of one conversation. A generation counter drops responses that arrive after the
// reader switched conversation or left the screen.
export function useChatHistory(chatId: string, current: MobileMessage[] | undefined) {
  const { request } = useConnection();
  const [older, setOlder] = useState<MobileMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const messages = useMemo(
    () => [
      ...new Map([...older, ...(current ?? [])].map((message) => [message.id, message])).values(),
    ],
    [older, current],
  );
  function reset() {
    generation.current++;
    setLoading(false);
    setError(null);
    setOlder([]);
    setDone(false);
  }
  // Reason: Each await re-checks that the reader is still on this conversation.
  // fallow-ignore-next-line complexity
  async function loadOlder(subChatId: string, beforeLoad: () => Promise<void>) {
    const first = messages[0];
    if (!first || loading) return;
    const started = generation.current;
    const stale = () => started !== generation.current;
    setLoading(true);
    await beforeLoad();
    if (stale()) return;
    setError(null);
    try {
      const page = await request({ type: 'chat', id: chatId, subChatId, beforeMessageId: first.id });
      if (stale()) return;
      setOlder((old) => [...page.messages, ...old]);
      setDone(!page.hasMore);
    } catch (reason) {
      if (!stale())
        setError(reason instanceof Error ? reason.message : 'Could not load earlier messages.');
    } finally {
      if (!stale()) setLoading(false);
    }
  }
  return { messages, error, loading, done, loadOlder, reset };
}
