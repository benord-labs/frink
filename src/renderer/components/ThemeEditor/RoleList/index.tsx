import { Button, Input } from '@benord-labs/frink-primitives';
import { RotateCcw, Search } from 'lucide-react';
import { memo, type ReactElement, useEffect, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isUserOverride, statedColor } from '@/lib/themes/editor/draft';
import { isHardToRead } from '@/lib/themes/editor/readability';
import { filterRoleGroups, SELECTED_ROLE_CLASS } from '@/lib/themes/editor/role-list';
import { type Palette, ROLE_LABELS, type Role } from '@/lib/themes/palette/roles';
import type { Half } from '@/lib/themes/palette/theme-schema';
import { cn } from '@/lib/utils';
import { ColorField } from '../ColorField';

type RoleRowProps = {
  role: Role;
  value: string;
  changed: boolean;
  hardToRead: boolean;
  selected: boolean;
  /** "3 places" (or "Not on screen") while this row's role is spotlit. */
  places: string | null;
  onChange: (role: Role, hex: string) => void;
  onReset: (role: Role) => void;
  onHover: (role: Role | null) => void;
};

// Memoised so a picker drag re-renders only the row whose colour moved.
const RoleRow = memo(function RoleRow({
  role,
  value,
  changed,
  hardToRead,
  selected,
  places,
  onChange,
  onReset,
  onHover,
}: RoleRowProps): ReactElement {
  const label = ROLE_LABELS[role];
  const [hovered, setHovered] = useState(false);
  // An effect, so a row removed under the pointer (filtered out, list closed) still lets go.
  useEffect(() => {
    if (!hovered) return;
    onHover(role);
    return () => onHover(null);
  }, [hovered, role, onHover]);
  return (
    <ColorField label={label} value={value} onChange={(hex) => onChange(role, hex)} size="row">
      {({ swatch, hex }) => (
        <div
          data-theme-role={role}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          className={cn(
            '-mx-2 grid h-7.5 grid-cols-[20px_1fr_auto_auto] items-center gap-2.5 rounded-[7px] px-2 text-[13px] transition-colors duration-150 hover:bg-primary/10 motion-reduce:transition-none',
            selected && SELECTED_ROLE_CLASS,
          )}
        >
          {swatch}
          <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
            {changed ? (
              <span title="Changed by you" className="size-[5px] shrink-0 rounded-full bg-primary">
                <span className="sr-only">Changed by you</span>
              </span>
            ) : null}
            <span className="truncate">{label}</span>
            {places ? <span className="text-[11px] font-medium text-primary">{places}</span> : null}
          </span>
          <span className="flex items-center gap-1">
            {hardToRead ? (
              <span className="rounded-[5px] bg-status-warning/12 px-1.5 text-[11px] leading-[18px] font-medium text-warning">
                Hard to read
              </span>
            ) : null}
            {changed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    iconOnly
                    aria-label={`Reset ${label}`}
                    onClick={() => onReset(role)}
                  >
                    <RotateCcw className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent data-theme-editor-panel="">Go back to Frink's pick</TooltipContent>
              </Tooltip>
            ) : null}
          </span>
          {hex}
        </div>
      )}
    </ColorField>
  );
});

function placesLabel(count: number): string {
  if (count === 0) return 'Not on screen';
  return count === 1 ? '1 place' : `${count} places`;
}

type Props = {
  half: Half;
  /** Overrides still inherited from the seed: they read as Frink's pick, not a change. */
  inherited: readonly Role[];
  /** The draft's derived colours, before contrast. */
  palette: Palette;
  selectedRole: Role | null;
  /** The spotlit role and how many places show it. */
  usage: { role: Role; count: number } | null;
  onChange: (role: Role, hex: string) => void;
  onReset: (role: Role) => void;
  onHover: (role: Role | null) => void;
};

/**
 * Every non-seed role in its group, filterable. Roles the user set carry a dot and a reset; text
 * below AA says so; hovering a row spotlights where its colour shows.
 */
export function RoleList({
  half,
  inherited,
  palette,
  selectedRole,
  usage,
  onChange,
  onReset,
  onHover,
}: Props): ReactElement {
  const [filter, setFilter] = useState('');
  const groups = filterRoleGroups(filter, selectedRole);

  return (
    <div className="space-y-1">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          size="xs"
          type="search"
          placeholder="Filter colors"
          aria-label="Filter colors"
          className="pl-8"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
      </div>
      {groups.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">No matches.</p>
      ) : null}
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h4 className="pt-3 pb-1 text-xs text-muted-foreground">{group.label}</h4>
          {group.roles.map((role) => (
            <RoleRow
              key={role}
              role={role}
              value={statedColor(half, role) ?? palette[role]}
              changed={isUserOverride(half, inherited, role)}
              hardToRead={isHardToRead(palette, role)}
              selected={role === selectedRole}
              places={usage?.role === role ? placesLabel(usage.count) : null}
              onChange={onChange}
              onReset={onReset}
              onHover={onHover}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
