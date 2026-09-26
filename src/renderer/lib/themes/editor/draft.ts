import { uniqueThemeId } from '../palette/built-in-themes';
import { type Appearance, ROLES, type Role } from '../palette/roles';
import { freeThemeName, type Half, type ThemeDefinition } from '../palette/theme-schema';
import type { ThemeEditorSession } from './editor-atoms';

/** What Save names a theme left blank; numbered when taken ("My theme 2"). */
const DEFAULT_THEME_NAME = 'My theme';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Typed or pasted text as `#rrggbb`, with or without the '#'; null when it is not a colour. */
export function parseHexColor(text: string): string | null {
  const hex = text.trim().replace(/^#?/, '#').toLowerCase();
  return HEX_COLOR.test(hex) ? hex : null;
}

export function isSeed(role: Role): role is 'background' | 'accent' {
  return role === 'background' || role === 'accent';
}

function withHalf(draft: ThemeDefinition, appearance: Appearance, half: Half): ThemeDefinition {
  return appearance === 'light' ? { ...draft, light: half } : { ...draft, dark: half };
}

/** Background and Accent set the seeds; any other role becomes an override. */
export function setRoleColor(half: Half, role: Role, hex: string): Half {
  if (isSeed(role)) return { ...half, [role]: hex };
  return { ...half, overrides: { ...half.overrides, [role]: hex } };
}

/** Drops a role's override so Frink derives it again. */
export function resetRole(half: Half, role: Role): Half {
  const overrides = { ...half.overrides };
  delete overrides[role];
  return { ...half, overrides };
}

/** The editor's working copy. `inherited` lists, per half, overrides still copied from the seed:
 * derivation takes them over once a seed moves; overrides the user sets stay theirs. */
export type EditorDraft = {
  theme: ThemeDefinition;
  inherited: Record<Appearance, readonly Role[]>;
};

const overriddenRoles = (half: Half) =>
  ROLES.filter((role) => half.overrides?.[role] !== undefined);

/** A new theme inherits its source's overrides; an edited theme's overrides are the user's own. */
export function startDraft({ seed, mode }: Pick<ThemeEditorSession, 'seed' | 'mode'>): EditorDraft {
  const inherits = mode === 'create';
  return {
    theme: seed,
    inherited: {
      light: inherits ? overriddenRoles(seed.light) : [],
      dark: inherits ? overriddenRoles(seed.dark) : [],
    },
  };
}

/** Sets `role` in one half; a seed edit releases that half's inherited overrides. */
export function editRole(
  draft: EditorDraft,
  appearance: Appearance,
  role: Role,
  hex: string,
): EditorDraft {
  const inherited = draft.inherited[appearance];
  const half = isSeed(role)
    ? inherited.reduce(resetRole, draft.theme[appearance])
    : draft.theme[appearance];
  return {
    theme: withHalf(draft.theme, appearance, setRoleColor(half, role, hex)),
    inherited: {
      ...draft.inherited,
      [appearance]: isSeed(role) ? [] : inherited.filter((each) => each !== role),
    },
  };
}

export function resetDraftRole(
  draft: EditorDraft,
  appearance: Appearance,
  role: Role,
): EditorDraft {
  return {
    theme: withHalf(draft.theme, appearance, resetRole(draft.theme[appearance], role)),
    inherited: {
      ...draft.inherited,
      [appearance]: draft.inherited[appearance].filter((each) => each !== role),
    },
  };
}

/** An override the user set, as opposed to one inherited from the seed or none at all. */
export function isUserOverride(half: Half, inherited: readonly Role[], role: Role): boolean {
  return half.overrides?.[role] !== undefined && !inherited.includes(role);
}

/** A role's colour as the draft states it; undefined for a role left to derivation. */
export function statedColor(half: Half, role: Role): string | undefined {
  return isSeed(role) ? half[role] : half.overrides?.[role];
}

function sameHalf(a: Half, b: Half): boolean {
  return (
    a.syntax === b.syntax && ROLES.every((role) => statedColor(a, role) === statedColor(b, role))
  );
}

/** Whether closing would lose work; override key order does not count as a change. */
export function isDraftChanged(seed: ThemeDefinition, draft: ThemeDefinition): boolean {
  return (
    seed.name !== draft.name ||
    !sameHalf(seed.light, draft.light) ||
    !sameHalf(seed.dark, draft.dark)
  );
}

/** Blank becomes "My theme"; a name another custom theme uses gets the next number. */
export function themeNameForSave(draftName: string, others: readonly ThemeDefinition[]): string {
  return freeThemeName(
    draftName.trim() || DEFAULT_THEME_NAME,
    others.map((theme) => theme.name),
  );
}

/** Custom themes other than the one being edited: the names a save must not reuse. */
export function otherThemes(
  session: ThemeEditorSession,
  customThemes: readonly ThemeDefinition[],
): readonly ThemeDefinition[] {
  if (session.mode === 'create') return customThemes;
  return customThemes.filter((theme) => theme.id !== session.editingId);
}

/** The theme Save stores: an edit keeps its id, a new theme gets a free slug of its name. */
export function themeToSave(
  session: ThemeEditorSession,
  draft: ThemeDefinition,
  customThemes: readonly ThemeDefinition[],
): ThemeDefinition {
  const name = themeNameForSave(draft.name, otherThemes(session, customThemes));
  const id = session.mode === 'edit' ? session.editingId : uniqueThemeId(name, customThemes);
  return { ...draft, name, id };
}

/** Replaces the theme with the same id in place, or appends a new one. */
export function upsertTheme(themes: ThemeDefinition[], theme: ThemeDefinition): ThemeDefinition[] {
  return themes.some((each) => each.id === theme.id)
    ? themes.map((each) => (each.id === theme.id ? theme : each))
    : [...themes, theme];
}
