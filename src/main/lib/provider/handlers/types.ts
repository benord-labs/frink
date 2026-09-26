/**
 * Per-category handler contract (PCH-1c).
 *
 * `deliver()`/`enforce()` dispatch off the {@link CapabilityDescriptor} into ONE
 * handler per category, registered in `./index`. Handlers are ASYNC (they do
 * file I/O) and PRE-REGISTERED as stubs so each later vertical edits ONLY its own
 * handler file — never the registry index (no merge contention between PCH-2/2b/6).
 */

import type { CapabilityMode, DispatchResult, ProviderType } from '../types';

/** Project-scoped context every handler receives. */
type HandlerCtx = {
  projectId: string;
  projectPath: string;
  provider: ProviderType;
};

/** A per-category deliver- or enforce-handler. Async — file I/O at the seam. */
export type CategoryHandler = (args: {
  mode: CapabilityMode;
  /** Only meaningful for enforce handlers (e.g. the intercepted tool call). */
  rule?: unknown;
  ctx: HandlerCtx;
}) => Promise<DispatchResult>;

/** A category may have a deliver handler, an enforce handler, or both. */
export type CategoryHandlers = {
  deliver?: CategoryHandler;
  enforce?: CategoryHandler;
};
