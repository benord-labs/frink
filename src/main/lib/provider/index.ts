/**
 * Provider spine — public barrel (PCH-1).
 *
 * The bridging surface for `provider-config-canonical-home` (Target #2). The
 * executor consumes `project()` at the spawn seam; later tickets fill the
 * per-mode handlers in `project.ts` without touching executor.ts.
 */

export { awaitBounded } from './await-bounded';
export { project } from './project';
export type { ProviderType } from './types';
