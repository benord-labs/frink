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
  pendingLeaveAtom,
  settleLeaveAtom,
} from '@/lib/code-editor/state';

type Props = {
  saveOpenFile: SaveOpenFile;
  /** Focus target after the dialog closes; the closed tab's editor is gone. */
  onCloseAutoFocus?: (event: Event) => void;
};

/**
 * Save / Don't save / Cancel for the unsaved tabs a tab close, or the whole window leaving
 * (`pendingLeaveAtom`), is waiting on. A leave goes ahead only once every tab is saved or let go.
 */
export function UnsavedChangesDialog({ saveOpenFile, onCloseAutoFocus }: Props): ReactElement {
  const [pendingKeys, setPendingKeys] = useAtom(pendingCloseKeysAtom);
  const files = useAtomValue(openFilesAtom);
  const closeFile = useSetAtom(closeFileAtom);
  const leaving = useAtomValue(pendingLeaveAtom) !== null;
  const settleLeave = useSetAtom(settleLeaveAtom);
  const [saving, setSaving] = useState(false);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const unmountedRef = useRef(false);

  // Unmounting with the prompt open answers it as Cancel, and stops a running Save from closing
  // tabs (a finished write stays on disk).
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      setPendingKeys(null);
      settleLeave('cancel');
    };
  }, [setPendingKeys, settleLeave]);

  const keys = pendingKeys ?? [];
  const onlyFile =
    keys.length === 1 ? files.find((f) => fileKey(f.path, f.projectPath) === keys[0]) : undefined;
  const title = onlyFile
    ? `Save changes to ${onlyFile.name}?`
    : `Save changes to ${keys.length} files?`;

  const saveAndClose = async () => {
    setSaving(true);
    let allSaved = true;
    const savedKeys = new Set<string>();
    try {
      for (const key of keys) {
        if (unmountedRef.current) break;
        // A save that throws counts as not saved, so a leave never goes ahead past it.
        const saved = await saveOpenFile(key).catch(() => false);
        if (unmountedRef.current) break;
        if (saved) {
          closeFile(key);
          savedKeys.add(key);
        } else allSaved = false;
      }
    } finally {
      setSaving(false);
      // A prompt opened while this save ran stays up, minus the tabs this save already wrote.
      let replaced = false;
      let emptied = false;
      setPendingKeys((current) => {
        replaced = current !== pendingKeys;
        if (!replaced || !current) return replaced ? current : null;
        const rest = current.filter((key) => !savedKeys.has(key));
        if (rest.length === current.length) return current;
        emptied = rest.length === 0;
        return emptied ? null : rest;
      });
      // An edit typed during the write, or a failed write, keeps the window.
      if (leaving && !replaced) settleLeave(allSaved ? 'confirm' : 'cancel');
      else if (emptied) settleLeave('confirm');
    }
  };

  const discardAndClose = () => {
    for (const key of keys) closeFile(key);
    setPendingKeys(null);
    settleLeave('confirm');
  };

  return (
    <AlertDialog
      open={pendingKeys !== null}
      onOpenChange={(open) => {
        if (open || saving) return;
        setPendingKeys(null);
        settleLeave('cancel');
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
