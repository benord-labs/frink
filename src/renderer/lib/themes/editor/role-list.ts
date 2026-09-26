import { ROLE_GROUPS, ROLE_LABELS, ROLES, type Role } from '../palette/roles';
import type { Half } from '../palette/theme-schema';
import { isSeed, isUserOverride } from './draft';

type RoleGroup = (typeof ROLE_GROUPS)[number];

/** Background and Accent have their own fields above the list, so it leaves them out. */
const LISTED_GROUPS: RoleGroup[] = ROLE_GROUPS.map((group) => ({
  label: group.label,
  roles: group.roles.filter((role) => !isSeed(role)),
}));

/** Highlights the row of the role Inspect picked. */
export const SELECTED_ROLE_CLASS = 'bg-primary/10 ring-1 ring-inset ring-ring';

/**
 * "All colors" groups matching `query` by group or role label. `keep` (the selected role) always
 * stays listed, so a filter never hides what Inspect just picked.
 */
export function filterRoleGroups(query: string, keep: Role | null): RoleGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return LISTED_GROUPS;
  return LISTED_GROUPS.map((group) => ({
    label: group.label,
    roles: group.label.toLowerCase().includes(needle)
      ? group.roles
      : group.roles.filter(
          (role) => role === keep || ROLE_LABELS[role].toLowerCase().includes(needle),
        ),
  })).filter((group) => group.roles.length > 0);
}

/** How many colours in `half` the user set by hand: the rows marked "Changed by you". */
export function changedRoleCount(half: Half, inherited: readonly Role[]): number {
  return ROLES.filter((role) => isUserOverride(half, inherited, role)).length;
}

/** Brings a role's row (`data-theme-role`) into view inside the editor's scroll area. */
export function scrollRoleIntoView(container: HTMLElement | null, role: Role): void {
  container?.querySelector(`[data-theme-role="${role}"]`)?.scrollIntoView({ block: 'nearest' });
}
