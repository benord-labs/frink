/** Picker rows → family, context window and effort tier. Grouping reads structured keys
 *  (`effort`, `contextDefault`), never labels, so relabelling a tier cannot regroup it. */
import type { ClaudeSdkEffortLevel } from '../../types/execution';

/** The fields grouping reads — structural so `src/shared` never imports the renderer's `ModelItem`. */
export type PickerGroupFields = {
  id: string;
  name: string;
  familyId?: string;
  contextLabel?: string;
  effort?: ClaudeSdkEffortLevel;
  effortDefault?: true;
  contextDefault?: true;
  ultra?: true;
};

export type PickerWindow<T extends PickerGroupFields> = {
  /** Short window label ("200k", "1M"). */
  label: string;
  isDefault: boolean;
  /** Effort tiers, lowest first. A single entry means there is no effort choice. */
  tiers: T[];
  defaultTier: T;
  /** Ultra twins of `tiers`, same order; empty when the window has no Ultra switch. */
  ultraTiers: T[];
};

export type PickerFamily<T extends PickerGroupFields> = {
  key: string;
  label: string;
  /** Catalog order. More than one means the user can pick a context window. */
  windows: PickerWindow<T>[];
  defaultWindow: PickerWindow<T>;
};

const EFFORT_RANK: readonly ClaudeSdkEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Display name for an effort key — `detail` can't serve, it carries the window ("1M · High"). */
export const EFFORT_LABEL = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
} satisfies Record<ClaudeSdkEffortLevel, string>;

function effortRank(m: PickerGroupFields): number {
  return m.effort ? EFFORT_RANK.indexOf(m.effort) : -1;
}

function byEffort<T extends PickerGroupFields>(tiers: T[]): T[] {
  return [...tiers].sort((a, b) => effortRank(a) - effortRank(b));
}

function toWindow<T extends PickerGroupFields>(rows: T[]): PickerWindow<T> {
  const tiers = rows.filter((t) => !t.ultra);
  const first = tiers[0];
  return {
    label: first.contextLabel?.replace(/ context$/, '') ?? '',
    isDefault: tiers.some((t) => t.contextDefault),
    tiers: byEffort(tiers),
    defaultTier: tiers.find((t) => t.effortDefault) ?? first,
    ultraTiers: byEffort(rows.filter((t) => t.ultra)),
  };
}

/** One entry per family, in catalog order, each holding its context windows. */
export function groupPickerModels<T extends PickerGroupFields>(
  models: readonly T[],
): PickerFamily<T>[] {
  const families = new Map<string, Map<string, T[]>>();
  for (const m of models) {
    const family = m.familyId ?? m.id;
    const windows = families.get(family) ?? new Map<string, T[]>();
    families.set(family, windows);
    const window = m.contextLabel ?? '';
    windows.set(window, [...(windows.get(window) ?? []), m]);
  }
  return Array.from(families, ([key, byWindow]) => {
    const windows = Array.from(byWindow.values(), toWindow);
    return {
      key,
      label: windows[0].tiers[0].name,
      windows,
      defaultWindow: windows.find((w) => w.isDefault) ?? windows[0],
    };
  });
}

/** The family and window holding `id`, or undefined for an id missing from the list. */
export function findPickerSelection<T extends PickerGroupFields>(
  families: readonly PickerFamily<T>[],
  id: string | undefined,
): { family: PickerFamily<T>; window: PickerWindow<T> } | undefined {
  for (const family of families) {
    const window = family.windows.find((w) =>
      [...w.tiers, ...w.ultraTiers].some((t) => t.id === id),
    );
    if (window) return { family, window };
  }
  return undefined;
}

/** The tier at `effort` in `window` (its Ultra twin when `ultra` and the window has one), else the
 *  window's default tier. */
export function pickInWindow<T extends PickerGroupFields>(
  window: PickerWindow<T>,
  effort: ClaudeSdkEffortLevel | undefined,
  ultra = false,
): T {
  const pool = ultra && window.ultraTiers.length ? window.ultraTiers : window.tiers;
  return (
    pool.find((t) => effort && t.effort === effort) ??
    pool.find((t) => t.effortDefault) ??
    window.defaultTier
  );
}
