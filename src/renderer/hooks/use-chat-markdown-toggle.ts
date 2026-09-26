import { useAtom } from 'jotai';
import { useCallback, useMemo } from 'react';
import { containsMarkdown } from '@/lib/utils/contains-markdown';
import { type ChatMarkdownMode, chatMarkdownModeAtom } from '../features/agents/atoms';

type BubbleRole = 'user' | 'assistant';

/** Resolve the tri-state pref for a role: null keeps the per-role default. */
export function resolveRenderMarkdown(mode: ChatMarkdownMode, role: BubbleRole): boolean {
  return mode === null ? role === 'assistant' : mode === 'rendered';
}

type ChatMarkdownToggle = {
  /** Whether this bubble should render markdown right now (vs raw text). */
  renderMarkdown: boolean;
  /** Whether to show the toggle at all — only when markdown is detected. */
  showToggle: boolean;
  /** Flip the global preference (applies to every bubble, persisted). */
  toggle: () => void;
};

/**
 * Resolve the chat-markdown render mode for one bubble and expose a flip.
 *
 * The preference is tri-state: `null` keeps each role's natural default
 * (assistant renders, user is raw); once the user toggles anything it becomes a
 * concrete `'raw' | 'rendered'` that governs ALL bubbles.
 */
export function useChatMarkdownToggle(role: BubbleRole, text: string): ChatMarkdownToggle {
  const [mode, setMode] = useAtom(chatMarkdownModeAtom);

  const renderMarkdown = resolveRenderMarkdown(mode, role);
  const showToggle = useMemo(() => containsMarkdown(text), [text]);

  const toggle = useCallback(
    () => setMode(renderMarkdown ? 'raw' : 'rendered'),
    [renderMarkdown, setMode],
  );

  return { renderMarkdown, showToggle, toggle };
}
