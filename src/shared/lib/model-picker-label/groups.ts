/** Picker rows → family, context window and effort tier. Grouping reads structured keys
 *  (`effort`, `contextDefault`), never labels, so relabelling a tier cannot regroup it. */
import type { PickerEffortLevel } from '../../types/execution';

/** The fields grouping reads — structural so `src/shared` never imports the renderer's `ModelItem`. */
export type PickerGroupFields = {
  id: string;
  name: string;
  familyId?: string;
  contextLabel?: string;
  effort?: PickerEffortLevel;
  effortDefault?: true;
  contextDefault?: true;
};

export type PickerWindow<T extends PickerGroupFields> = {
  /** Short window label ("200k", "1M"). */
  label: string;
  isDefault: boolean;
  /** Effort tiers, lowest first. A single entry means there is no effort choice. */
  tiers: T[];
  defaultTier: T;
};

export type PickerFamily<T extends PickerGroupFields> = {
  key: string;
  label: string;
  /** Catalog order. More than one means the user can pick a context window. */
  windows: PickerWindow<T>[];
  defaultWindow: PickerWindow<T>;
};

const EFFORT_RANK: readonly PickerEffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

/** Display name for an effort key — `detail` can't serve, it carries the window ("1M · High"). */
export const EFFORT_LABEL = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
} satisfies Record<PickerEffortLevel, string>;

function effortRank(m: PickerGroupFields): number {
  return m.effort ? EFFORT_RANK.indexOf(m.effort) : -1;
}

function toWindow<T extends PickerGroupFields>(tiers: T[]): PickerWindow<T> {
  const first = tiers[0];
  return {
    label: first.contextLabel?.replace(/ context$/, '') ?? '',
    isDefault: tiers.some((t) => t.contextDefault),
    tiers: [...tiers].sort((a, b) => effortRank(a) - effortRank(b)),
    defaultTier: tiers.find((t) => t.effortDefault) ?? first,
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
    const window = family.windows.find((w) => w.tiers.some((t) => t.id === id));
    if (window) return { family, window };
  }
  return undefined;
}

/** The tier at `effort` in `window`, or the window's default when it does not offer that tier. */
export function pickInWindow<T extends PickerGroupFields>(
  window: PickerWindow<T>,
  effort: PickerEffortLevel | undefined,
): T {
  return window.tiers.find((t) => effort && t.effort === effort) ?? window.defaultTier;
}
