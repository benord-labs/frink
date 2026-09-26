import { Button, Textarea } from '@benord-labs/frink-primitives';
import { useAtom } from 'jotai';
import { FileJson } from 'lucide-react';
import { type DragEvent, type ReactElement, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  type ConflictChoice,
  importThemes,
  mergeImportedThemes,
  type ThemeSource,
} from '@/lib/themes/import/import-themes';
import { snapshotStockHalf } from '@/lib/themes/palette/stock-palette';
import { customThemesAtom } from '@/lib/themes/palette/theme-atoms';
import type { ThemeDefinition } from '@/lib/themes/palette/theme-schema';
import { cn } from '@/lib/utils';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function importedMessage(themes: readonly ThemeDefinition[]): string {
  return themes.length === 1
    ? `Imported “${themes[0].name}”.`
    : `Imported ${themes.length} themes.`;
}

function conflictMessage(conflicts: readonly ThemeDefinition[]): string {
  return conflicts.length === 1
    ? `You already have “${conflicts[0].name}”. Keep both, or replace it?`
    : `You already have ${conflicts.length} of these themes. Keep both, or replace them?`;
}

/** Text dragged into the paste box is left to the browser. */
function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer.types.includes('Files');
}

/** The dialog's content; the whole surface takes file drops, so none can navigate the window. */
function ImportForm({ onDone }: { onDone: () => void }): ReactElement {
  const [customThemes, setCustomThemes] = useAtom(customThemesAtom);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pasteId = useId();
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState<ThemeDefinition[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const conflicts = customThemes.filter((saved) => pending?.some((theme) => theme.id === saved.id));

  const save = (themes: ThemeDefinition[], choice: ConflictChoice, failures: string[]) => {
    setPending(null);
    if (themes.length === 0) return;
    // Merge into the library as it is now: another window may have saved a theme mid-import.
    let imported: ThemeDefinition[] = [];
    const saved = setCustomThemes((current) => {
      const merged = mergeImportedThemes(current, themes, choice);
      imported = merged.imported;
      return merged.themes;
    });
    if (!saved) {
      setErrors(["Your saved themes couldn't be loaded, so nothing was imported."]);
      return;
    }
    toast(importedMessage(imported));
    if (failures.length === 0) onDone();
  };

  const run = async (sources: ThemeSource[]) => {
    setBusy(true);
    const { themes, errors: failures } = await importThemes(sources, snapshotStockHalf).finally(
      () => setBusy(false),
    );
    setErrors(failures);
    if (themes.some((theme) => customThemes.some((saved) => saved.id === theme.id))) {
      setPending(themes);
    } else {
      save(themes, 'keep-both', failures);
    }
  };

  const onDrop = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDropping(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0 && !busy && !pending) void run(files);
  };

  return (
    <DialogContent
      className="sm:max-w-lg"
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )
        )
          setDropping(false);
      }}
      onDrop={onDrop}
    >
      <DialogHeader>
        <DialogTitle>Import theme</DialogTitle>
        <DialogDescription>
          Bring in a Frink theme file or a VS Code color theme (.json).
        </DialogDescription>
      </DialogHeader>
      <div
        className={cn(
          'flex items-center gap-3 rounded-xl border border-dashed p-4 transition-colors',
          dropping ? 'border-primary bg-primary/5' : 'border-border',
        )}
      >
        <FileJson className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">Drop theme files here</p>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || pending !== null}
          onClick={() => fileInputRef.current?.click()}
        >
          Choose files
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          multiple
          hidden
          aria-label="Theme files"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            if (files.length > 0) void run(files);
          }}
        />
      </div>

      <div className="grid gap-1.5">
        <label htmlFor={pasteId} className="text-sm font-medium">
          Or paste a theme
        </label>
        <Textarea
          id={pasteId}
          rows={6}
          spellCheck={false}
          value={text}
          placeholder="Paste the contents of a theme file"
          className="font-mono text-xs"
          onChange={(event) => setText(event.target.value)}
        />
      </div>

      {errors.length > 0 ? (
        <p role="alert" className="whitespace-pre-line text-xs text-destructive">
          {errors.join('\n')}
        </p>
      ) : null}

      {pending ? (
        <div className="grid gap-3 rounded-xl border border-border bg-muted/40 p-3">
          <p role="alert" className="text-sm">
            {conflictMessage(conflicts)}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              autoFocus
              onClick={() => save(pending, 'keep-both', errors)}
            >
              Keep both
            </Button>
            <Button onClick={() => save(pending, 'replace', errors)}>Replace</Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button
            disabled={!text.trim() || busy}
            onClick={() => void run([{ size: text.length, text: () => Promise.resolve(text) }])}
          >
            Import
          </Button>
        </div>
      )}
    </DialogContent>
  );
}

/** Imports Frink theme files and VS Code colour themes into the user's themes, without using them. */
export function ThemeImportDialog({ open, onOpenChange }: Props): ReactElement {
  // Each opening gets a fresh form; the last one stays mounted through the close animation.
  const [openings, setOpenings] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpenings((count) => count + 1);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ImportForm key={openings} onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}
