/**
 * Cloud client — barrel re-export.
 *
 * Prefer importing from here. Domain implementations live in src/main/lib/cloud/.
 * Add a new re-export line here each time a new domain file is created.
 *
 * Domain files (post-0.0.6 local-first cleanup — most cloud function exports
 * have been deleted; type re-exports remain as the source of truth for the
 * cloud-shape DTOs consumed by routers/renderer):
 *   trigger-rules.ts — @deprecated; only DbTriggerRule type kept (live renderer + router consumers)
 *   flows.ts       — flow DTO types only (the reads/writes live in db/repos)
 *   trigger-bindings.ts — @deprecated; DbFlowTriggerBinding type kept (router uses db/repos)
 */

// './cloud' is the domain barrel: core only. Deprecated domains stay
// per-module below so .oxlintrc.json can ban them individually.
export * from './cloud';
export * from './cloud/custom-node-types';
export * from './cloud/flows';
export * from './cloud/trigger-bindings';
export * from './cloud/trigger-rules';
