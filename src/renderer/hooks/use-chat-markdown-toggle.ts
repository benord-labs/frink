import { useAtom } from 'jotai';
import { useCallback, useMemo } from 'react';
import { containsMarkdown } from '@/lib/utils/contains-markdown';
import { chatMarkdownAssistantAtom, chatMarkdownUserAtom } from '../lib/atoms';

export type BubbleRole = 'user' | 'assistant';

const CHAT_MARKDOWN_ATOMS = {
  assistant: chatMarkdownAssistantAtom,
  user: chatMarkdownUserAtom,
};

type ChatMarkdownToggle = {
  /** Whether this bubble should render markdown right now (vs raw text). */
  renderMarkdown: boolean;
  /** Whether to show the toggle at all — only when markdown is detected. */
  showToggle: boolean;
  /** Flip this role's preference (applies to every bubble of the role, persisted). */
  toggle: () => void;
};

/**
 * Resolve the chat-markdown render mode for one bubble and expose a flip.
 *
 * Each role has its own persisted switch (assistant on, user off by default), so
 * toggling one role never changes the other. Settings → Preferences shows both.
 */
export function useChatMarkdownToggle(role: BubbleRole, text: string): ChatMarkdownToggle {
  const [renderMarkdown, setRenderMarkdown] = useAtom(CHAT_MARKDOWN_ATOMS[role]);
  const showToggle = useMemo(() => containsMarkdown(text), [text]);

  const toggle = useCallback(
    () => setRenderMarkdown(!renderMarkdown),
    [renderMarkdown, setRenderMarkdown],
  );

  return { renderMarkdown, showToggle, toggle };
}
