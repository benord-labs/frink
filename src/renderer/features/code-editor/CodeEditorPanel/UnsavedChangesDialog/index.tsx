import { buttonVariants } from '@benord-labs/frink-primitives';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { SaveOpenFile } from '@/lib/code-editor/files/use-save-open-file';
import {
  closeFileAtom,
  fileKey,
  openFilesAtom,
  pendingCloseKeysAtom,
} from '@/lib/code-editor/state';

type Props = {
  saveOpenFile: SaveOpenFile;
  /** Focus target after the dialog closes; the closed tab's editor is gone. */
  onCloseAutoFocus?: (event: Event) => void;
};

/** Save / Don't save / Cancel for the unsaved tabs a close is waiting on. */
export function UnsavedChangesDialog({ saveOpenFile, onCloseAutoFocus }: Props): ReactElement {
  const [pendingKeys, setPendingKeys] = useAtom(pendingCloseKeysAtom);
  const files = useAtomValue(openFilesAtom);
  const closeFile = useSetAtom(closeFileAtom);
  const [saving, setSaving] = useState(false);
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  // Leaving the editor with the prompt open (e.g. the phone Work Queue) answers it as Cancel.
  useEffect(() => () => setPendingKeys(null), [setPendingKeys]);

  const keys = pendingKeys ?? [];
  const onlyFile =
    keys.length === 1 ? files.find((f) => fileKey(f.path, f.projectPath) === keys[0]) : undefined;
  const title = onlyFile
    ? `Save changes to ${onlyFile.name}?`
    : `Save changes to ${keys.length} files?`;

  const saveAndClose = async () => {
    setSaving(true);
    try {
      for (const key of keys) {
        if (await saveOpenFile(key)) closeFile(key);
      }
    } finally {
      setSaving(false);
      // A prompt opened while this save ran (after this one was dismissed) stays up.
      setPendingKeys((current) => (current === pendingKeys ? null : current));
    }
  };

  const discardAndClose = () => {
    for (const key of keys) closeFile(key);
    setPendingKeys(null);
  };

  return (
    <AlertDialog
      open={pendingKeys !== null}
      onOpenChange={(open) => {
        if (!open && !saving) setPendingKeys(null);
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          saveButtonRef.current?.focus();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            Your changes will be lost if you don&apos;t save them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <button
            type="button"
            className={buttonVariants({ variant: 'destructive' })}
            disabled={saving}
            onClick={discardAndClose}
          >
            Don&apos;t save
          </button>
          <button
            ref={saveButtonRef}
            type="button"
            className={buttonVariants()}
            disabled={saving}
            onClick={() => void saveAndClose()}
          >
            Save
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
