import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Files, Folder } from 'lucide-react';
import { useOutsideClick } from '@/hooks/use-outside-click';
import { cn } from '@/lib/utils';
import { getFileIconByExtension } from '../../agents/mentions/agents-file-mention';
import { TREE_BASE_PADDING, TREE_CHEVRON_SPACER_PX, TREE_INDENT_WIDTH } from '../constants';

type Props = {
  /** 'file' or 'folder' */
  type: 'file' | 'folder';
  /** Indent level (0 = root) */
  level: number;
  /** Called with the entered name on confirm */
  onConfirm: (name: string) => void;
  /** Called when the user cancels (Escape or empty blur) */
  onCancel: () => void;
  /** Pre-fill value (used for rename) */
  defaultValue?: string;
};

const INVALID_NAME_MESSAGE = 'Names cannot contain path separators or "..".';

function getValidationError(name: string): string | null {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return INVALID_NAME_MESSAGE;
  }

  return null;
}

/**
 * Inline text input that appears in the file tree for creating new files/folders.
 * Matches the visual style of a TreeNode row.
 */
export function InlineInput({ type, level, onConfirm, onCancel, defaultValue = '' }: Props) {
  const [value, setValue] = useState(defaultValue);
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const errorMessageId = useId();
  const inputAriaLabel = defaultValue ? `Rename ${type} ${defaultValue}` : `New ${type} name`;

  // Dismiss inline input when clicking outside
  useOutsideClick({
    refs: [containerRef],
    onBlur: onCancel,
  });

  // Auto-focus on mount. Create flows suppress Radix close auto-focus at the menu layer,
  // so both create and rename can use the same deterministic focus timing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only run on mount — defaultValue/type are stable initial props
  useEffect(() => {
    const focusInput = () => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      if (defaultValue) {
        const dotIndex = defaultValue.lastIndexOf('.');
        if (dotIndex > 0 && type === 'file') {
          input.setSelectionRange(0, dotIndex);
        } else {
          input.select();
        }
      }
    };
    requestAnimationFrame(focusInput);
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === defaultValue) {
      onCancel();
      return;
    }

    const error = getValidationError(trimmed);
    if (error) {
      setValidationError(error);
      inputRef.current?.setCustomValidity(error);
      inputRef.current?.reportValidity();
      inputRef.current?.focus();
      return;
    }

    onConfirm(trimmed);
  }, [value, defaultValue, onConfirm, onCancel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    },
    [handleSubmit, onCancel],
  );

  const isFolder = type === 'folder';

  // Debounce the icon lookup so it doesn't recalculate on every keystroke
  const [debouncedValue, setDebouncedValue] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), 150);
    return () => clearTimeout(timer);
  }, [value]);

  // Resolve the file icon based on the current (debounced) input value
  // biome-ignore lint/style/useNamingConvention: component type variable
  const FileIcon = useMemo(() => {
    if (isFolder) return Folder;
    if (!debouncedValue) return Files;
    return getFileIconByExtension(debouncedValue) ?? Files;
  }, [isFolder, debouncedValue]);

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex items-center gap-1.5 py-1.5 px-2 rounded-md text-sm',
        'ring-1 ring-primary/60 bg-muted/30',
      )}
      style={{ paddingLeft: `${level * TREE_INDENT_WIDTH + TREE_BASE_PADDING}px` }}
    >
      {/* Spacer so icon aligns with TreeNode rows (folder: chevron slot; file: same) */}
      <span className="shrink-0" style={{ width: TREE_CHEVRON_SPACER_PX }} aria-hidden="true" />
      <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        aria-label={inputAriaLabel}
        onChange={(e) => {
          setValue(e.target.value);
          setValidationError(null);
          e.target.setCustomValidity('');
        }}
        onKeyDown={handleKeyDown}
        onBlur={(e) => {
          const rt = e.relatedTarget as HTMLElement | null;
          // When focus goes nowhere (Radix cleanup) or to an ancestor
          // (the tabIndex=0 tree container), reclaim focus instead of dismissing.
          if (!rt || rt === document.body || rt.contains(e.currentTarget)) {
            requestAnimationFrame(() => inputRef.current?.focus());
          }
        }}
        className={cn(
          'flex-1 min-w-0 bg-transparent outline-hidden text-sm text-foreground',
          'placeholder:text-muted-foreground/50',
        )}
        aria-invalid={validationError ? 'true' : undefined}
        aria-describedby={validationError ? errorMessageId : undefined}
        aria-errormessage={validationError ? errorMessageId : undefined}
        placeholder={isFolder ? 'Folder name...' : 'File name...'}
        spellCheck={false}
        autoComplete="off"
      />
      {validationError && (
        <p id={errorMessageId} role="alert" className="sr-only">
          {validationError}
        </p>
      )}
    </div>
  );
}
