/**
 * Provider spine — shared types (PCH-1).
 *
 * Implements the epic `provider-config-canonical-home` (Target #2, 2026-06-08,
 * docs/decisions/): Frink owns canonical config in `~/.frink` and bridges it
 * across the big-5 coding CLIs via TWO VERBS — DELIVER data + ENFORCE rules.
 * Each provider's capability row (shared/lib/ai-providers) drives data-driven dispatch
 * (LSP-style negotiation); adding a 6th provider is a DATA ROW, not new code.
 */

import type {
  CapabilityCategory,
  CapabilityMode,
  Delivery,
} from '../../../shared/lib/ai-providers/capabilities';

/**
 * Dispatch outcome status. `noop` while a category's handler is a stub or the
 * mode doesn't apply; `enforced` = an enforce-check ran and PASSED; `denied` =
 * an enforce-check ran and the call must be blocked (the gate turns this into
 * the host deny).
 */
type DispatchStatus = 'noop' | 'delivered' | 'enforced' | 'denied';

/** Outcome of a single `deliver()`/`enforce()` dispatch. */
export type DispatchResult = {
  category: CapabilityCategory;
  mode: CapabilityMode;
  status: DispatchStatus;
  detail?: string;
};

/** Result of a switch-time capability probe. */
export type ProbeResult = {
  /** Whether Frink can make any bridging promise for this provider. */
  supported: boolean;
  /** The capability row dispatch will run against. */
  descriptor: Delivery;
  /** Human-readable reason — populated when `supported` is false. */
  reason?: string;
};
