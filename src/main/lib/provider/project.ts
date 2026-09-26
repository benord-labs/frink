/**
 * Provider spine — the `project()` interface (PCH-1; async + registry PCH-1c).
 *
 * ONE interface, data-driven dispatch. `probe()` is real + sync (a data lookup);
 * `deliver()`/`enforce()` are ASYNC (handlers do file I/O) and route off the
 * per-category {@link CapabilityMode} into a PRE-REGISTERED handler (one file per
 * category under `./handlers/`). Later tickets fill ONLY their handler file —
 * never this dispatcher or the registry index, and never the ~4000-line executor.ts:
 *   PCH-2 skills (copy) · PCH-2b commands (copy) · PCH-3 MCP (inject) ·
 *   PCH-4 agent brain (inject) · PCH-5 allowlist (enforce/advisory) · PCH-6 hooks (file).
 */

import { getCapabilityDescriptor } from './capabilities';
import { categoryHandlers } from './handlers';
import type { CapabilityCategory, DispatchResult, ProbeResult, ProviderType } from './types';

/** The set of providers we have a verified, non-`none` descriptor for. */
const VERIFIED_PROVIDERS: ReadonlySet<ProviderType> = new Set(['claude-code', 'cursor', 'codex']);

/**
 * The provider-scoped interface every downstream ticket inherits. Constructed
 * via {@link project}; dispatches off the capability descriptor + handler registry.
 */
export type ProjectProvider = {
  readonly projectId: string;
  readonly projectPath: string;
  readonly provider: ProviderType;
  probe(): ProbeResult;
  deliver(category: CapabilityCategory): Promise<DispatchResult>;
  enforce(category: CapabilityCategory, rule?: unknown): Promise<DispatchResult>;
};

/**
 * Construct a provider-scoped interface for one project. `project()` itself is
 * pure + cheap (a descriptor lookup); the async work lives in the handlers.
 * Named `project` to match the epic's `project(projectId, projectPath, provider)`.
 */
export function project(
  projectId: string,
  projectPath: string,
  provider: ProviderType,
): ProjectProvider {
  const descriptor = getCapabilityDescriptor(provider);
  const ctx = { projectId, projectPath, provider };

  return {
    projectId,
    projectPath,
    provider,
    probe(): ProbeResult {
      if (VERIFIED_PROVIDERS.has(provider)) {
        return { supported: true, descriptor };
      }
      return {
        supported: false,
        descriptor,
        reason: `Provider '${provider}' is not yet verified; capabilities unavailable (TODO PCH-8).`,
      };
    },
    async deliver(category: CapabilityCategory): Promise<DispatchResult> {
      const mode = descriptor[category];
      if (mode === 'none') {
        return { category, mode, status: 'noop', detail: 'not bridged for this provider' };
      }
      const handler = categoryHandlers(category)?.deliver;
      if (!handler) {
        // Category is a rule (enforce-only) — deliver() is a no-op for it.
        return { category, mode, status: 'noop', detail: 'rule mode — use enforce()' };
      }
      return handler({ mode, ctx });
    },
    async enforce(category: CapabilityCategory, rule?: unknown): Promise<DispatchResult> {
      const mode = descriptor[category];
      if (mode === 'none') {
        return { category, mode, status: 'noop', detail: 'not bridged for this provider' };
      }
      const handler = categoryHandlers(category)?.enforce;
      if (!handler) {
        // Category is data (deliver-only) — enforce() is a no-op for it.
        return { category, mode, status: 'noop', detail: 'deliver mode — use deliver()' };
      }
      return handler({ mode, rule, ctx });
    },
  };
}
