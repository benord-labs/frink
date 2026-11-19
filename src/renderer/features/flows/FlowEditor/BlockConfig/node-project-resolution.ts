/**
 * Project resolution for flow node blocks (node override vs flow default), and whether the
 * resolved value names a project on this computer — by the same rules the runtime dispatchers use.
 */

export type ProjectRef = { id: string; name: string };
export type ProjectRefState = 'ok' | 'missing' | 'unknown' | 'ambiguous' | 'malformed';
export type ProjectRefRules = { byName: boolean; templates: boolean };
/** A start_task / run_command step's own value: `resolveDispatchProjectId` renders it first. */
export const STEP_PROJECT_RULES: ProjectRefRules = { byName: true, templates: true };
/** The flow default: dispatch matches it by id or unique name but never renders it. */
export const LITERAL_PROJECT_RULES: ProjectRefRules = { byName: true, templates: false };
/** Custom nodes (`resolveStaticProjectId`) and post-task bindings match an id only. */
export const ID_ONLY_PROJECT_RULES: ProjectRefRules = { byName: false, templates: false };

export function getEffectiveNodeProjectId(
  projectId: string,
  flowDefaultProjectId: string | undefined,
): string | undefined {
  const trimmedBlock = projectId.trim();
  if (trimmedBlock !== '') return trimmedBlock;
  return flowDefaultProjectId?.trim() || undefined;
}

type ProjectRow = { id: string; name: string; path: string };

/** `trpc.projects.list` rows as refs, or `null` while the list is loading or unavailable. */
export function toProjectRefs(rows: readonly ProjectRow[] | undefined): ProjectRef[] | null {
  return rows ? rows.map((p) => ({ id: p.id, name: p.name })) : null;
}

/** The project a value resolves to: by id, else by a name only one project has. */
function findProjectRef<T extends ProjectRef>(
  value: string,
  projects: readonly T[],
): T | undefined {
  const key = value.trim();
  const byId = projects.find((p) => p.id === key);
  if (byId) return byId;
  const byName = projects.filter((p) => p.name === key);
  return byName.length === 1 ? byName[0] : undefined;
}

/** What a picker shows for a stored value: the project it resolves to, else the raw value. */
export function pickerProject(
  value: string,
  rows: readonly ProjectRow[] | undefined,
  rules: ProjectRefRules,
): ProjectRow {
  const projects = rows ?? [];
  const found = rules.byName
    ? findProjectRef(value, projects)
    : projects.find((p) => p.id === value.trim());
  return found ?? { id: value, name: value, path: '' };
}

/** A `null` project list skips the check, so nothing is flagged while it loads. */
export function classifyProjectRef(
  value: string | undefined,
  projects: readonly ProjectRef[] | null,
  rules: ProjectRefRules,
): ProjectRefState {
  const key = value?.trim() ?? '';
  if (key === '') return 'missing';
  if (projects === null) return 'ok';
  if (rules.templates) {
    // Dispatch rejects any brace left once well-formed placeholders are removed (project-id.ts).
    if (/[{}]/.test(key.replace(/\{\{[^{}]+\}\}/g, ''))) return 'malformed';
    if (key.includes('{{')) return 'ok';
  }
  if (projects.some((p) => p.id === key)) return 'ok';
  if (!rules.byName) return 'unknown';
  const named = projects.filter((p) => p.name === key).length;
  if (named === 1) return 'ok';
  return named > 1 ? 'ambiguous' : 'unknown';
}

export function projectRefMessage(
  state: ProjectRefState,
  value: string | undefined,
): string | null {
  const key = value?.trim() ?? '';
  switch (state) {
    case 'ok':
      return null;
    case 'missing':
      return 'Select a project.';
    case 'unknown':
      return `The project “${key}” isn't on this computer. Pick a project.`;
    case 'ambiguous':
      return `More than one project is named “${key}”. Pick one.`;
    case 'malformed':
      return `“${key}” isn't a valid variable. Fix it or pick a project.`;
  }
}

export type NodeProjectProblem = {
  state: Exclude<ProjectRefState, 'ok'>;
  value: string;
  /** The flow default is the value in use, so flow settings is where it gets fixed. */
  fromDefault: boolean;
};

/** Why a step's project (its own, else the flow default) won't resolve at run time, if it won't. */
export function nodeProjectProblem(
  ownProjectId: string,
  flowDefaultProjectId: string | undefined,
  projects: readonly ProjectRef[] | null,
  stepRules: ProjectRefRules,
): NodeProjectProblem | null {
  const own = ownProjectId.trim();
  const fromDefault = own === '';
  const value = fromDefault ? (flowDefaultProjectId?.trim() ?? '') : own;
  const rules = fromDefault ? { ...stepRules, templates: false } : stepRules;
  const state = classifyProjectRef(value, projects, rules);
  return state === 'ok' ? null : { state, value, fromDefault };
}

export function getNodeProjectFieldError(
  ownProjectId: string,
  flowDefaultProjectId: string | undefined,
  projects: readonly ProjectRef[] | null,
  stepRules: ProjectRefRules,
): string | null {
  const problem = nodeProjectProblem(ownProjectId, flowDefaultProjectId, projects, stepRules);
  return problem ? projectRefMessage(problem.state, problem.value) : null;
}
