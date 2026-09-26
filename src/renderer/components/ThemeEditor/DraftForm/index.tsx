import { Button } from '@benord-labs/frink-primitives';
import { useAtom, useAtomValue } from 'jotai';
import { ChevronDown, Crosshair, Moon, Sun } from 'lucide-react';
import { type ReactElement, useEffect, useId, useMemo, useRef } from 'react';
import { ThemeStrip } from '@/components/dialogs/settings-tabs/appearance/ThemeStrip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  themeEditorSelectedRoleAtom,
  themeEditorShowAllAtom,
} from '@/lib/themes/editor/editor-atoms';
import { changedRoleCount, scrollRoleIntoView } from '@/lib/themes/editor/role-list';
import type { ThemeDraft } from '@/lib/themes/editor/use-theme-draft';
import type { ThemeInspector } from '@/lib/themes/editor/use-theme-inspector';
import { derivePalette } from '@/lib/themes/palette/derive';
import type { Palette } from '@/lib/themes/palette/roles';
import { MAX_THEME_NAME_LENGTH } from '@/lib/themes/palette/theme-schema';
import { cn } from '@/lib/utils';
import { RoleList } from '../RoleList';
import { SeedTile } from '../SeedTile';

const SIDES = [
  { appearance: 'light', label: 'Light', Icon: Sun },
  { appearance: 'dark', label: 'Dark', Icon: Moon },
] as const;

const SEEDS = [
  { role: 'background', label: 'Background', description: 'Behind everything' },
  { role: 'accent', label: 'Accent', description: 'Buttons, links, selection' },
] as const;

/** Both halves of the draft as strips, each switching the editor to its side; the edited one is ringed. */
function SideSwitch({ editor, palette }: { editor: ThemeDraft; palette: Palette }): ReactElement {
  const otherHalf = editor.draft[editor.appearance === 'light' ? 'dark' : 'light'];
  const otherPalette = useMemo(() => derivePalette(otherHalf), [otherHalf]);
  return (
    <div className="grid grid-cols-2 gap-2">
      {SIDES.map(({ appearance, label, Icon }) => {
        const editing = appearance === editor.appearance;
        return (
          <ThemeStrip
            key={appearance}
            as="button"
            size="fill"
            palette={editing ? palette : otherPalette}
            on={editing}
            aria-pressed={editing}
            onClick={() => editor.setAppearance(appearance)}
            className={cn(
              'flex-col-reverse rounded-[10px] p-1.5',
              !editing && 'shadow-[inset_0_0_0_1px_hsl(var(--border)/0.7)]',
            )}
          >
            <span
              className={cn(
                'flex items-center gap-1.5 px-0.5 text-xs font-medium',
                !editing && 'text-muted-foreground',
              )}
            >
              <Icon className="size-3" />
              {editing ? `${label} · editing` : label}
            </span>
          </ThemeStrip>
        );
      })}
    </div>
  );
}

type Props = {
  editor: ThemeDraft;
  inspector: ThemeInspector;
  /** The draft's derived colours. */
  palette: Palette;
  /** The name Save uses when the field is left blank. */
  namePlaceholder: string;
};

/** Name, the side being edited, the two seed colours and, on request, every role. */
export function DraftForm({ editor, inspector, palette, namePlaceholder }: Props): ReactElement {
  // "All colors" only changes the view; overrides persist while it is closed.
  const [showAll, setShowAll] = useAtom(themeEditorShowAllAtom);
  const selectedRole = useAtomValue(themeEditorSelectedRoleAtom);
  const listId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const changed = changedRoleCount(editor.half, editor.inherited);

  useEffect(() => {
    if (selectedRole) scrollRoleIntoView(scrollRef.current, selectedRole);
  }, [selectedRole]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-3.5">
      <input
        aria-label="Theme name"
        autoFocus
        value={editor.draft.name}
        maxLength={MAX_THEME_NAME_LENGTH}
        placeholder={namePlaceholder}
        onChange={(event) => editor.rename(event.currentTarget.value)}
        className="w-full border-b border-dashed border-border bg-transparent pr-1 pb-1 text-xl leading-tight font-semibold tracking-tight text-foreground italic outline-hidden placeholder:text-muted-foreground focus-visible:border-solid focus-visible:border-primary"
      />

      <SideSwitch editor={editor} palette={palette} />

      <div className="grid grid-cols-2 gap-2">
        {SEEDS.map(({ role, label, description }) => (
          <SeedTile
            key={role}
            role={role}
            label={label}
            description={description}
            value={editor.half[role]}
            onChange={(hex) => editor.changeRole(role, hex)}
            selected={role === selectedRole}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Frink works out every other color from these two.
      </p>

      <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
        <button
          type="button"
          aria-expanded={showAll}
          aria-controls={listId}
          onClick={() => setShowAll(!showAll)}
          className="flex items-center gap-1.5 rounded-sm text-[13px] font-medium outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown
            className={cn(
              'size-3.5 transition-transform motion-reduce:transition-none',
              !showAll && '-rotate-90',
            )}
          />
          All colors
          {changed > 0 ? (
            <span className="text-xs font-normal text-muted-foreground">· {changed} changed</span>
          ) : null}
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={inspector.armed}
              onClick={inspector.toggle}
              className="border border-border text-foreground aria-pressed:border-primary aria-pressed:text-primary"
            >
              <Crosshair className="size-3.5" />
              Pick from screen
            </Button>
          </TooltipTrigger>
          <TooltipContent data-theme-editor-panel="">
            Click anything in Frink to edit its color.
          </TooltipContent>
        </Tooltip>
      </div>

      {showAll ? (
        <div id={listId}>
          <RoleList
            half={editor.half}
            inherited={editor.inherited}
            palette={palette}
            selectedRole={selectedRole}
            usage={inspector.usage}
            onChange={editor.changeRole}
            onReset={editor.resetRole}
            onHover={inspector.hover}
          />
        </div>
      ) : null}
    </div>
  );
}
