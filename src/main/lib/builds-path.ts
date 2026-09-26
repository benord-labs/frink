import { join, sep } from 'node:path';

/**
 * Display name a build project carries until the chat auto-namer (autoNameSubChat →
 * maybeNameBuildProject) resolves a friendly LLM title from the first message. The FOLDER stays a
 * slug (invisible plumbing); only this display name is shown, then replaced. The namer gates on
 * `name === this` so it only ever (re)names a still-unresolved build. Lives here (leaf module) so
 * both the scaffolder and the namer share one source without coupling.
 */
export const BUILD_PROJECT_PLACEHOLDER = 'New project';

/** Root directory for Frink-managed "New project" builds: `<home>/.frink/builds`. */
export function buildsRootDir(homeDir: string): string {
  return join(homeDir, '.frink', 'builds');
}

/**
 * True only when `projectPath` is a folder Frink created under `<home>/.frink/builds/`. Used to
 * gate the on-disk folder removal in `projects.delete` — getting this wrong would delete a
 * user-opened folder. The trailing separator is load-bearing: it prevents a sibling like
 * `.frink/builds-evil/` from matching the `.frink/builds` prefix.
 */
export function isManagedBuildPath(projectPath: string, homeDir: string): boolean {
  return projectPath.startsWith(buildsRootDir(homeDir) + sep);
}
