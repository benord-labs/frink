import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { SlashCommandOption } from '@/lib/commands/types';
import { trpc } from '../../../lib/trpc';

/**
 * Shared state + callbacks for the command editor modal.
 * Used by both new-chat-form and chat-input-area to avoid duplication.
 */
export function useCommandEditor(opts?: {
  /** Called before opening the edit modal (e.g. to close the slash dropdown) */
  onBeforeEdit?: () => void;
}) {
  const [commandEditorOpen, setCommandEditorOpen] = useState(false);
  const [editingCommand, setEditingCommand] = useState<SlashCommandOption | null>(null);
  const [prefillName, setPrefillName] = useState('');
  const [prefillContent, setPrefillContent] = useState('');

  const trpcUtils = trpc.useUtils();

  const openCreate = useCallback((name?: string) => {
    setEditingCommand(null);
    setPrefillName(name ?? '');
    setPrefillContent('');
    setCommandEditorOpen(true);
  }, []);

  const openEdit = useCallback(
    (cmd: SlashCommandOption) => {
      opts?.onBeforeEdit?.();
      setEditingCommand(cmd);
      setPrefillName('');
      setPrefillContent('');
      setCommandEditorOpen(true);
    },
    [opts?.onBeforeEdit],
  );

  /** Fork a non-frink command: fetch its content, then open the create modal pre-filled. */
  const handleFork = useCallback(
    async (cmd: SlashCommandOption) => {
      if (!cmd.path) return;
      try {
        const { content } = await trpcUtils.commands.getContent.fetch({ path: cmd.path });
        opts?.onBeforeEdit?.();
        setEditingCommand(null);
        setPrefillName(cmd.name);
        setPrefillContent(content);
        setCommandEditorOpen(true);
      } catch {
        toast.error('Failed to read command content');
      }
    },
    [trpcUtils, opts?.onBeforeEdit],
  );

  return {
    commandEditorOpen,
    setCommandEditorOpen,
    editingCommand,
    prefillName,
    prefillContent,
    openCreate,
    openEdit,
    handleFork,
  } as const;
}
