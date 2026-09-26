import { useCallback, useState } from 'react';
import { handlePasteEvent } from '@/lib/utils/paste-text';

type Props = {
  onAddAttachments: (files: File[]) => void;
  onAddPastedText: (text: string) => Promise<void>;
  onAddTaskContext?: (taskData: { id: string; title: string; description: string }) => void;
};

type ReturnValue = {
  // Mention dropdown state
  showMentionDropdown: boolean;
  mentionSearchText: string;
  mentionPosition: { top: number; left: number };
  showingFilesList: boolean;
  showingSkillsList: boolean;
  showingAgentsList: boolean;
  showingToolsList: boolean;
  setShowingFilesList: (show: boolean) => void;
  setShowingSkillsList: (show: boolean) => void;
  setShowingAgentsList: (show: boolean) => void;
  setShowingToolsList: (show: boolean) => void;

  // Slash command dropdown state
  showSlashDropdown: boolean;
  slashSearchText: string;
  slashPosition: { top: number; left: number };

  // Focus and drag state
  isFocused: boolean;
  isDragOver: boolean;
  setIsFocused: (focused: boolean) => void;

  // Event handlers
  handleMentionTrigger: (params: { searchText: string; rect: DOMRect }) => void;
  handleCloseTrigger: () => void;
  handleSlashTrigger: (params: { searchText: string; rect: DOMRect }) => void;
  handleCloseSlashTrigger: () => void;
  handlePaste: (e: React.ClipboardEvent) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => void;
};

/**
 * Manages editor interaction state and event handlers
 * (mentions, slash commands, paste, drag & drop)
 */
export function useEditorHandlers({
  onAddAttachments,
  onAddPastedText,
  onAddTaskContext,
}: Props): ReturnValue {
  // Mention dropdown state
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionSearchText, setMentionSearchText] = useState('');
  const [mentionPosition, setMentionPosition] = useState({ top: 0, left: 0 });
  const [showingFilesList, setShowingFilesList] = useState(false);
  const [showingSkillsList, setShowingSkillsList] = useState(false);
  const [showingAgentsList, setShowingAgentsList] = useState(false);
  const [showingToolsList, setShowingToolsList] = useState(false);

  // Slash command dropdown state
  const [showSlashDropdown, setShowSlashDropdown] = useState(false);
  const [slashSearchText, setSlashSearchText] = useState('');
  const [slashPosition, setSlashPosition] = useState({ top: 0, left: 0 });

  // Focus state
  const [isFocused, setIsFocused] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Mention handlers
  const handleMentionTrigger = useCallback(
    ({ searchText, rect }: { searchText: string; rect: DOMRect }) => {
      setMentionSearchText(searchText);
      setMentionPosition({ top: rect.top, left: rect.left });
      setShowingFilesList(false);
      setShowingSkillsList(false);
      setShowingAgentsList(false);
      setShowingToolsList(false);
      setShowMentionDropdown(true);
    },
    [],
  );

  const handleCloseTrigger = useCallback(() => {
    setShowMentionDropdown(false);
    setShowingFilesList(false);
    setShowingSkillsList(false);
    setShowingAgentsList(false);
    setShowingToolsList(false);
  }, []);

  // Slash command handlers
  const handleSlashTrigger = useCallback(
    ({ searchText, rect }: { searchText: string; rect: DOMRect }) => {
      setSlashSearchText(searchText);
      setSlashPosition({ top: rect.top, left: rect.left });
      setShowSlashDropdown(true);
    },
    [],
  );

  const handleCloseSlashTrigger = useCallback(() => {
    setShowSlashDropdown(false);
  }, []);

  // Paste handler for images, plain text, and large text
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => handlePasteEvent(e, onAddAttachments, onAddPastedText),
    [onAddAttachments, onAddPastedText],
  );

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      // Check if this is a task drop
      const taskId = e.dataTransfer.getData('application/task-id');
      if (taskId && onAddTaskContext) {
        const title = e.dataTransfer.getData('application/task-title');
        const description = e.dataTransfer.getData('application/task-description');
        onAddTaskContext({ id: taskId, title, description });
        return;
      }

      // Otherwise, handle as file drop
      const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
      onAddAttachments(files);
    },
    [onAddAttachments, onAddTaskContext],
  );

  return {
    showMentionDropdown,
    mentionSearchText,
    mentionPosition,
    showingFilesList,
    showingSkillsList,
    showingAgentsList,
    showingToolsList,
    setShowingFilesList,
    setShowingSkillsList,
    setShowingAgentsList,
    setShowingToolsList,
    showSlashDropdown,
    slashSearchText,
    slashPosition,
    isFocused,
    isDragOver,
    setIsFocused,
    handleMentionTrigger,
    handleCloseTrigger,
    handleSlashTrigger,
    handleCloseSlashTrigger,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
