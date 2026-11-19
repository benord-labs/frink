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

import { AI_PROVIDERS, type AiProviderId } from '../../../shared/lib/ai-providers';
import type { CapabilityCategory } from '../../../shared/lib/ai-providers/capabilities';
import { categoryHandlers } from './handlers';
import type { DispatchResult, ProbeResult } from './types';

/**
 * The provider-scoped interface every downstream ticket inherits. Constructed
 * via {@link project}; dispatches off the provider's capability row + handler registry.
 */
export type ProjectProvider = {
  readonly projectId: string;
  readonly projectPath: string;
  readonly provider: AiProviderId;
  probe(): ProbeResult;
  deliver(category: CapabilityCategory): Promise<DispatchResult>;
  enforce(category: CapabilityCategory, rule?: unknown): Promise<DispatchResult>;
};

/**
 * Construct a provider-scoped interface for one project. `project()` itself is
 * pure + cheap (a row lookup); the async work lives in the handlers.
 * Named `project` to match the epic's `project(projectId, projectPath, provider)`.
 */
export function project(
  projectId: string,
  projectPath: string,
  provider: AiProviderId,
): ProjectProvider {
  const { delivery } = AI_PROVIDERS[provider].capabilities;
  const ctx = { projectId, projectPath, provider };

  return {
    projectId,
    projectPath,
    provider,
    probe(): ProbeResult {
      // Instructions only report: no handler delivers them, so they make nothing deliverable.
      const delivers = Object.entries(delivery).some(
        ([category, mode]) => category !== 'instructions' && mode !== 'none',
      );
      if (delivers) return { supported: true, descriptor: delivery };
      return {
        supported: false,
        descriptor: delivery,
        reason: `Frink delivers nothing to ${AI_PROVIDERS[provider].longName} yet.`,
      };
    },
    async deliver(category: CapabilityCategory): Promise<DispatchResult> {
      const mode = delivery[category];
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
      const mode = delivery[category];
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
