import { type ReactNode, useContext } from 'react';
import { MentionChipContext } from '../../lib/mentions/mention-chip-context';

type MarkdownMentionProps = { children?: ReactNode; 'data-mention-id'?: string };

/** A mention token in rendered markdown: the surface's chip when it draws one, else the raw token. */
export function MarkdownMention({ children, 'data-mention-id': id = '' }: MarkdownMentionProps) {
  const renderChip = useContext(MentionChipContext);
  return renderChip?.(id) ?? children;
}
