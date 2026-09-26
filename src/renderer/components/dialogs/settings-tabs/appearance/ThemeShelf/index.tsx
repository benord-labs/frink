import { Button } from '@benord-labs/frink-primitives';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { Copy, Download, Import, Moon, MoreHorizontal, PenLine, Sun, Trash2 } from 'lucide-react';
import { useTheme } from 'next-themes';
import { type ReactElement, type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { openThemeEditorAtom } from '@/lib/themes/editor/editor-atoms';
import { keptCopy } from '@/lib/themes/import/import-themes';
import {
  BUILT_IN_THEMES,
  FRINK_THEME_ID,
  findTheme,
  type Theme,
} from '@/lib/themes/palette/built-in-themes';
import type { ThemeHalves } from '@/lib/themes/palette/resolve';
import type { Appearance, Palette } from '@/lib/themes/palette/roles';
import {
  customThemesAtom,
  customThemesUnavailableAtom,
  themeHalvesAtom,
} from '@/lib/themes/palette/theme-atoms';
import type { ThemeDefinition } from '@/lib/themes/palette/theme-schema';
import {
  downloadThemeFile,
  themeCopy,
  withViewTransition,
} from '@/lib/themes/preview/theme-actions';
import { themeHalfPalette } from '@/lib/themes/preview/theme-palette';
import { cn } from '@/lib/utils';
import { SETTINGS_GLASS_PANEL_CLASS } from '../../settings-tab-surface';
import { NewThemeButton } from '../NewThemeButton';
import { ThemeImportDialog } from '../ThemeImportDialog';
import { SHELF_GRID_CLASS, ThemeRow } from './ThemeRow';

const UNAVAILABLE_TIP = 'Unavailable until your saved themes can be read';

type ActionTooltipProps = {
  tip?: string;
  /** Explains that the themes library is unreadable instead. */
  unavailable?: boolean;
  children: ReactElement;
};

/** A disabled button gets no pointer events, so its tooltip hangs off a focusable wrapper. */
function ActionTooltip({ tip, unavailable, children }: ActionTooltipProps): ReactNode {
  const content = unavailable ? UNAVAILABLE_TIP : tip;
  if (!content) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {unavailable ? (
          <span tabIndex={0} className="inline-flex">
            {children}
          </span>
        ) : (
          children
        )}
      </TooltipTrigger>
      <TooltipContent>{content}</TooltipContent>
    </Tooltip>
  );
}

type ThemeMenuProps = {
  theme: Theme;
  /** Built-ins offer only Customize; your own themes are edited in place. */
  custom?: ThemeDefinition;
  unavailable: boolean;
  onCustomize: () => void;
  onEdit: (theme: ThemeDefinition) => void;
  onDelete: (theme: ThemeDefinition) => void;
};

function ThemeMenu({
  theme,
  custom,
  unavailable,
  onCustomize,
  onEdit,
  onDelete,
}: ThemeMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" iconOnly aria-label={`More for ${theme.name}`}>
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {custom ? (
          <>
            <DropdownMenuItem onSelect={() => onEdit(custom)}>
              <PenLine className="mr-2 size-3.5" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onCustomize}>
              <Copy className="mr-2 size-3.5" />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => downloadThemeFile(custom)}>
              <Download className="mr-2 size-3.5" />
              Export file
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDelete(custom)} className="text-destructive">
              <Trash2 className="mr-2 size-3.5" />
              Delete
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem disabled={unavailable} onSelect={onCustomize}>
            <PenLine className="mr-2 size-3.5" />
            Customize
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Using Clay in light and dark", announced once per pick. */
function pickAnnouncement({ light, dark }: Record<Appearance, Theme>): string {
  return light.id === dark.id
    ? `Using ${light.name} in light and dark`
    : `Using ${light.name} in light and ${dark.name} in dark`;
}

/** Undo puts the theme back on each half it was using, unless one was picked there since. */
function restoredHalves(halves: ThemeHalves, wasUsing: Record<Appearance, boolean>, id: string) {
  return {
    light: wasUsing.light && halves.light === FRINK_THEME_ID ? id : halves.light,
    dark: wasUsing.dark && halves.dark === FRINK_THEME_ID ? id : halves.dark,
  };
}

/** Says a delete or its undo was refused because the saved themes could not be read. */
function refused(theme: ThemeDefinition, what: 'deleted' | 'restored'): void {
  toast.error(`Your saved themes couldn't be read, so “${theme.name}” wasn't ${what}.`);
}

type Deleted = { theme: ThemeDefinition; index: number; wasUsing: Record<Appearance, boolean> };

/** Undo of a delete, against the library and picks as they are when it is clicked. */
function restoreTheme(store: ReturnType<typeof useStore>, { theme, index, wasUsing }: Deleted) {
  // A theme made since the delete may have taken this id.
  const current = store.get(customThemesAtom);
  const restored = current.some((each) => each.id === theme.id) ? keptCopy(theme, current) : theme;
  const saved = store.set(customThemesAtom, (themes) => [
    ...themes.slice(0, index),
    restored,
    ...themes.slice(index),
  ]);
  if (!saved) {
    refused(theme, 'restored');
    return;
  }
  store.set(themeHalvesAtom, (halves) => restoredHalves(halves, wasUsing, restored.id));
}

type Props = {
  /** Stock Frink as globals.css paints it; null until read. */
  stock: Record<Appearance, Palette> | null;
};

/** Every theme as a row with its light and dark colours, plus the ways to make a new theme. */
export function ThemeShelf({ stock }: Props): ReactElement {
  const [halves, setHalves] = useAtom(themeHalvesAtom);
  const [customThemes, setCustomThemes] = useAtom(customThemesAtom);
  const unavailable = useAtomValue(customThemesUnavailableAtom);
  const openEditor = useSetAtom(openThemeEditorAtom);
  const store = useStore();
  const { resolvedTheme } = useTheme();
  const [importOpen, setImportOpen] = useState(false);
  const visible: Appearance = resolvedTheme === 'dark' ? 'dark' : 'light';
  const inUse = {
    light: findTheme(halves.light, customThemes),
    dark: findTheme(halves.dark, customThemes),
  };
  const owners = { light: inUse.light.id, dark: inUse.dark.id };

  const use = (id: string, appearance?: Appearance) =>
    withViewTransition(() =>
      setHalves((current) =>
        appearance ? { ...current, [appearance]: id } : { light: id, dark: id },
      ),
    );
  const createFrom = (theme: Theme, name: string) =>
    openEditor({ mode: 'create', appearance: visible, seed: themeCopy(theme, name, customThemes) });
  const edit = (theme: ThemeDefinition) =>
    openEditor({ mode: 'edit', editingId: theme.id, seed: theme, appearance: visible });

  const remove = (theme: ThemeDefinition) => {
    // Read now, not from render: another window may have changed either since.
    const index = store.get(customThemesAtom).findIndex((each) => each.id === theme.id);
    const halvesNow = store.get(themeHalvesAtom);
    const wasUsing = { light: halvesNow.light === theme.id, dark: halvesNow.dark === theme.id };
    if (!setCustomThemes((themes) => themes.filter((each) => each.id !== theme.id))) {
      refused(theme, 'deleted');
      return;
    }
    setHalves((current) => ({
      light: wasUsing.light ? FRINK_THEME_ID : current.light,
      dark: wasUsing.dark ? FRINK_THEME_ID : current.dark,
    }));
    toast(`“${theme.name}” deleted`, {
      duration: 8000,
      // The close button would sit on top of Undo.
      closeButton: false,
      action: { label: 'Undo', onClick: () => restoreTheme(store, { theme, index, wasUsing }) },
    });
  };

  const row = (theme: Theme, custom?: ThemeDefinition) => (
    <ThemeRow
      key={theme.id}
      theme={theme}
      palettes={{
        light: themeHalfPalette(theme, 'light', stock),
        dark: themeHalfPalette(theme, 'dark', stock),
      }}
      owners={owners}
      onUse={(appearance) => use(theme.id, appearance)}
      menu={
        <ThemeMenu
          theme={theme}
          custom={custom}
          unavailable={unavailable}
          onCustomize={() => createFrom(theme, `${theme.name} copy`)}
          onEdit={edit}
          onDelete={remove}
        />
      }
    />
  );
  const showing = inUse[visible];

  return (
    <div
      className={cn(SETTINGS_GLASS_PANEL_CLASS, 'tile-rim flex flex-col overflow-hidden rounded-2xl p-0')}
    >
      <div className={cn(SHELF_GRID_CLASS, 'h-10 text-xs text-muted-foreground')}>
        <span />
        <span className="flex items-center justify-center gap-1.5">
          <Sun aria-hidden className="size-3" />
          Light
        </span>
        <span className="flex items-center justify-center gap-1.5">
          <Moon aria-hidden className="size-3" />
          Dark
        </span>
      </div>
      {BUILT_IN_THEMES.map((theme) => row(theme))}
      {unavailable ? (
        <p role="status" className="px-[18px] py-2 text-xs text-destructive">
          Your saved themes couldn't be read, so Frink is leaving them untouched. Built-in themes
          still work. Restart Frink to try again.
        </p>
      ) : null}
      {customThemes.length > 0 ? (
        <>
          <p className="mt-1.5 border-t border-border/55 px-[18px] pt-3.5 pb-1 text-xs text-muted-foreground">
            Your themes
          </p>
          {customThemes.map((theme) => row(theme, theme))}
        </>
      ) : null}
      <div className="mt-1.5 flex items-center justify-between gap-3 border-t border-border/55 py-2 pr-3 pl-2.5">
        <ActionTooltip unavailable={unavailable}>
          <NewThemeButton
            from={showing.name}
            disabled={unavailable}
            onClick={() => createFrom(showing, 'My theme')}
          />
        </ActionTooltip>
        <ActionTooltip unavailable={unavailable}>
          <Button
            variant="ghost"
            size="sm"
            disabled={unavailable}
            onClick={() => setImportOpen(true)}
          >
            <Import className="size-3.5" />
            Import
          </Button>
        </ActionTooltip>
      </div>
      <p aria-live="polite" className="sr-only">
        {pickAnnouncement(inUse)}
      </p>
      <ThemeImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
