// Frink-managed "New project" builds live under ~/.frink/builds/. Renderer-safe check (no
// node:path here) — matches both POSIX and Windows separators. Mirrors the main-process
// isManagedBuildPath gate in src/main/lib/builds-path.ts, used only for cosmetics (the icon).
const BUILD_PROJECT_RE = /[/\\]\.frink[/\\]builds[/\\]/;

/** True when a project path is a Frink-managed build (used to give it a distinct icon). */
export function isBuildProjectPath(path?: string | null): boolean {
  return !!path && BUILD_PROJECT_RE.test(path);
}
