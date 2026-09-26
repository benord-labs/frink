import { Button, buttonVariants } from '@benord-labs/frink-primitives';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { ChevronLeft, RotateCcw, X } from 'lucide-react';
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useState,
} from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useSettingsNavigation } from '@/hooks/useSettingsNavigation';
import { agentsSettingsDialogOpenAtom } from '@/lib/atoms';
import { otherThemes, themeNameForSave, themeToSave, upsertTheme } from '@/lib/themes/editor/draft';
import { closeThemeEditorAtom, type ThemeEditorSession } from '@/lib/themes/editor/editor-atoms';
import { useDraftPreview } from '@/lib/themes/editor/use-draft-preview';
import { DOCK_WIDTH_CLASS } from '@/lib/themes/editor/use-theme-editor-dock';
import { useThemeDraft } from '@/lib/themes/editor/use-theme-draft';
import { useThemeInspector } from '@/lib/themes/editor/use-theme-inspector';
import { customThemesAtom, themeHalvesAtom } from '@/lib/themes/palette/theme-atoms';
import { cn } from '@/lib/utils';
import { DraftForm } from '../DraftForm';

// `title` names the panel for assistive tech; the name field is its visible title.
const COPY = {
  create: { title: 'New theme', save: 'Create theme' },
  edit: { title: 'Edit theme', save: 'Save changes' },
} as const;

/**
 * Esc belongs to the panel's own layers: an open picker closes itself, else Esc drops Inspect's
 * pick. It never closes the panel, and it stops here, so it never bubbles to app shortcuts.
 */
function keepEscapeInside(event: KeyboardEvent, clearInspect: () => void): void {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  if (!event.defaultPrevented) clearInspect();
}

/**
 * Hands focus back when the panel unmounts and took focus with it: to where focus was before it
 * opened, else the chat composer, else nowhere.
 */
function restoreFocus(previous: Element | null): void {
  if (document.activeElement && document.activeElement !== document.body) return;
  const target =
    previous?.isConnected && previous !== document.body
      ? previous
      : document.querySelector('[data-chat-input="true"]');
  if (target instanceof HTMLElement) target.focus({ preventScroll: true });
}

/** Back to Settings › Appearance, the live-preview note, and close. */
function PanelHeader({ onClose }: { onClose: () => void }): ReactElement {
  const { openSettingsTab } = useSettingsNavigation();
  return (
    <div className="flex items-center gap-1.5 border-b border-border/60 py-2 pr-2 pl-1.5">
      <Button variant="ghost" size="xs" onClick={() => openSettingsTab('appearance')}>
        <ChevronLeft className="size-3.5" />
        Appearance
      </Button>
      <span className="ml-auto rounded-full border border-border px-2 text-[11px] leading-[18px] font-medium text-muted-foreground">
        Previewing live
      </span>
      <Button variant="ghost" size="xs" iconOnly aria-label="Close theme editor" onClick={onClose}>
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

type DiscardDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onDiscard: () => void;
};

function DiscardDialog({ open, onOpenChange, name, onDiscard }: DiscardDialogProps): ReactElement {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader className="space-y-2">
          <AlertDialogTitle>Discard changes to “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Frink goes back to the theme you had before.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: 'destructive' })}
            onClick={onDiscard}
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type PanelBodyProps = Omit<ComponentProps<typeof DraftForm>, 'namePlaceholder'> & {
  session: ThemeEditorSession;
  onCancel: () => void;
};

/** The draft form and its footer. Save stores the draft and puts it on. */
function PanelBody({ session, editor, onCancel, ...form }: PanelBodyProps): ReactElement {
  const [customThemes, setCustomThemes] = useAtom(customThemesAtom);
  const setHalves = useSetAtom(themeHalvesAtom);
  const closeEditor = useSetAtom(closeThemeEditorAtom);
  const store = useStore();

  const save = () => {
    // Named against the library as it is now: another window may have saved a theme since render.
    const theme = themeToSave(session, editor.draft, store.get(customThemesAtom));
    if (!setCustomThemes((themes) => upsertTheme(themes, theme))) {
      toast.error("Your custom themes couldn't be loaded, so this theme wasn't saved.");
      return;
    }
    setHalves({ light: theme.id, dark: theme.id });
    closeEditor();
    toast(`“${theme.name}” is on.`);
  };

  return (
    <>
      <DraftForm
        editor={editor}
        {...form}
        namePlaceholder={themeNameForSave('', otherThemes(session, customThemes))}
      />
      <div className="flex items-center justify-between gap-1 border-t border-border/60 px-2.5 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          className="px-2"
          disabled={!editor.changed}
          onClick={editor.revert}
        >
          <RotateCcw className="size-3.5" />
          Undo my changes
        </Button>
        <div className="flex gap-1.5">
          <Button variant="ghost" size="sm" className="px-2" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            {COPY[session.mode].save}
          </Button>
        </div>
      </div>
    </>
  );
}

/**
 * The docked theme editor. The workspace beside it is the live preview; the draft stays local
 * until Save, and closing hands the stored theme back.
 */
export function ThemeEditorPanel({ session }: { session: ThemeEditorSession }): ReactElement {
  const editor = useThemeDraft(session);
  const settingsOpen = useAtomValue(agentsSettingsDialogOpenAtom);
  // Settings' own chrome shows the stored theme; the draft repaints once it closes.
  const palette = useDraftPreview(editor.draft.id, editor.half, editor.appearance, settingsOpen);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const inspector = useThemeInspector(settingsOpen || confirmingDiscard);
  const closeEditor = useSetAtom(closeThemeEditorAtom);
  // Read before the name field autofocuses, so closing can return focus here.
  const [previousFocus] = useState(() => document.activeElement);

  useEffect(() => () => restoreFocus(previousFocus), [previousFocus]);

  const requestClose = () => {
    if (editor.changed) setConfirmingDiscard(true);
    else closeEditor();
  };

  return (
    <aside
      aria-label={COPY[session.mode].title}
      data-theme-editor-panel=""
      onKeyDown={(event) => keepEscapeInside(event, inspector.clear)}
      className={cn(DOCK_WIDTH_CLASS, 'flex shrink-0 flex-col py-2 pr-2 pl-1')}
    >
      <div className="unified-sidebar-glass flex min-h-0 flex-1 flex-col overflow-hidden">
        <PanelHeader onClose={requestClose} />
        <p
          role="status"
          className="border-b border-border/60 px-4 py-1.5 box-content min-h-4 text-xs text-muted-foreground"
        >
          {inspector.status}
        </p>
        <PanelBody
          session={session}
          editor={editor}
          inspector={inspector}
          palette={palette}
          onCancel={requestClose}
        />
      </div>

      <DiscardDialog
        open={confirmingDiscard}
        onOpenChange={setConfirmingDiscard}
        name={editor.draft.name.trim() || session.seed.name}
        onDiscard={closeEditor}
      />
    </aside>
  );
}
