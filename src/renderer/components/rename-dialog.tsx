import { Button, Input } from '@benord-labs/frink-primitives';
import { useCallback, useEffect, useState } from 'react';
import {
  CanvasDialogBody,
  CanvasDialogContent,
  CanvasDialogFooter,
  CanvasDialogHeader,
  Dialog,
  DialogTitle,
} from './ui/dialog';

type RenameDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
  currentName: string;
  isLoading?: boolean;
  title?: string;
  placeholder?: string;
};

export function RenameDialog({
  isOpen,
  onClose,
  onSave,
  currentName,
  isLoading = false,
  title = 'Rename',
  placeholder = 'Name',
}: RenameDialogProps) {
  const [name, setName] = useState(currentName);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isOpen) setName(currentName);
  }, [isOpen, currentName]);

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName === currentName) {
      onClose();
      return;
    }

    setIsSaving(true);
    try {
      await onSave(trimmedName);
      onClose();
    } catch {
      // Error is already handled by parent (toast), keep dialog open
    } finally {
      setIsSaving(false);
    }
  }, [name, currentName, onSave, onClose]);

  const isUnchanged = !name.trim() || name.trim() === currentName;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !isSaving) onClose();
      }}
    >
      <CanvasDialogContent className="sm:max-w-[400px]">
        <CanvasDialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </CanvasDialogHeader>

        <CanvasDialogBody>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSave();
              }
            }}
            onFocus={(e) => e.target.select()}
            placeholder={placeholder}
            size="lg"
            disabled={isSaving || isLoading}
            autoFocus
          />
        </CanvasDialogBody>

        <CanvasDialogFooter>
          <Button
            onClick={onClose}
            variant="ghost"
            disabled={isSaving || isLoading}
            className="rounded-md"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            variant="primary"
            disabled={isUnchanged || isSaving || isLoading}
            className="rounded-md"
          >
            {isSaving || isLoading ? 'Saving...' : 'Save'}
          </Button>
        </CanvasDialogFooter>
      </CanvasDialogContent>
    </Dialog>
  );
}
