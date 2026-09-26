import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue } from 'jotai';
import { Check, Pencil, X } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { TextShimmer } from '../../../components/ui/text-shimmer';
import { TypewriterText } from '../../../components/ui/typewriter-text';
import { cn } from '../../../lib/utils';
import { justCreatedIdsAtom } from '../atoms';

type ChatTitleEditorProps = {
  name: string;
  placeholder?: string;
  onSave: (newName: string) => Promise<void>;
  isMobile?: boolean;
  disabled?: boolean;
  chatId?: string;
  hasMessages?: boolean;
};

// Custom comparison to prevent re-renders during streaming
function areTitlePropsEqual(prev: ChatTitleEditorProps, next: ChatTitleEditorProps): boolean {
  return (
    prev.name === next.name &&
    prev.placeholder === next.placeholder &&
    prev.isMobile === next.isMobile &&
    prev.disabled === next.disabled &&
    prev.chatId === next.chatId &&
    prev.hasMessages === next.hasMessages
  );
}

/** Inline edit row: title input + Save (✓) / Cancel (✗) affordances. */
function TitleEditRow({
  inputRef,
  value,
  onChange,
  onKeyDown,
  onSave,
  onCancel,
  isSaving,
  placeholder,
  isMobile,
}: {
  inputRef: React.Ref<HTMLInputElement>;
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSave: () => void;
  onCancel: () => void;
  isSaving: boolean;
  placeholder: string;
  isMobile: boolean;
}) {
  return (
    <div className="flex h-full items-center gap-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={isSaving}
        placeholder={placeholder}
        className={cn(
          // Boxed treatment (border + fill) is the always-on edit-state signal; the
          // focus ring matches the shared Input component (primary token).
          'min-w-0 flex-1 h-full rounded-md border border-input bg-muted/40 px-2 font-medium text-foreground outline-hidden',
          'focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/20',
          isMobile ? 'text-base' : 'text-lg',
        )}
      />
      <Button
        variant="ghost"
        size="icon"
        onClick={onSave}
        disabled={isSaving}
        aria-label="Save title"
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onCancel}
        disabled={isSaving}
        aria-label="Cancel rename"
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export const ChatTitleEditor = memo(function ChatTitleEditor({
  name,
  placeholder = 'New Chat',
  onSave,
  isMobile = false,
  disabled = false,
  chatId,
  hasMessages = false,
}: ChatTitleEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(name);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const justCreatedIds = useAtomValue(justCreatedIdsAtom);

  // Sync editValue when name changes externally
  useEffect(() => {
    if (!isEditing) {
      setEditValue(name);
    }
  }, [name, isEditing]);

  // Auto-focus and select text when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      const timeoutId = setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 0);
      return () => clearTimeout(timeoutId);
    }
  }, [isEditing]);

  const handleSave = useCallback(async () => {
    const trimmedValue = editValue.trim();

    // If empty or unchanged, just cancel
    if (!trimmedValue || trimmedValue === name) {
      setEditValue(name);
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    try {
      await onSave(trimmedValue);
      setIsEditing(false);
    } catch {
      // On error, revert to original name
      setEditValue(name);
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  }, [editValue, name, onSave]);

  const handleCancel = useCallback(() => {
    setEditValue(name);
    setIsEditing(false);
  }, [name]);

  // Clicking outside DISCARDS the edit — with explicit Save (✓)/Cancel (✗) controls,
  // a stray click off the title must not silently commit a rename. ✓ / Enter commit.
  useEffect(() => {
    if (!isEditing) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        handleCancel();
      }
    };

    // Add delay to avoid immediate trigger
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isEditing, handleCancel]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleCancel();
    }
  };

  const isJustCreated = chatId ? justCreatedIds.has(chatId) : false;
  const hasRealName = name && name !== placeholder;
  // Async chat-name generation is in flight when the chat has messages but no
  // resolved name yet. Render a shimmering placeholder so the user sees that
  // a title is on the way instead of a static "New Chat".
  const isGeneratingName = !hasRealName && hasMessages;

  const handleClick = () => {
    // Don't allow editing if disabled or if it's a placeholder (not saved to DB yet)
    if (!disabled && !isEditing && hasRealName) {
      setIsEditing(true);
    }
  };

  return (
    <div ref={containerRef} className="max-w-2xl mx-auto px-4 h-7">
      {isEditing ? (
        <TitleEditRow
          inputRef={inputRef}
          value={editValue}
          onChange={setEditValue}
          onKeyDown={handleKeyDown}
          onSave={handleSave}
          onCancel={handleCancel}
          isSaving={isSaving}
          placeholder={placeholder}
          isMobile={isMobile}
        />
      ) : (
        // Title is display-only; editing starts ONLY via the pencil button (not by
        // clicking the title text). Pencil reveals on row-hover or its own focus.
        <div className="group flex h-full w-full items-center gap-1.5">
          <span
            className={cn(
              'min-w-0 flex-1 truncate font-medium',
              isMobile ? 'text-base' : 'text-lg',
              hasRealName ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {isGeneratingName ? (
              <TextShimmer as="span" variant="spectrum" duration={1.5}>
                Generating title…
              </TextShimmer>
            ) : (
              <TypewriterText
                text={name}
                placeholder={placeholder}
                id={chatId}
                isJustCreated={isJustCreated}
                showPlaceholder={hasMessages}
              />
            )}
          </span>
          {hasRealName && !disabled && (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleClick}
              aria-label="Edit chat title"
              className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}, areTitlePropsEqual);
