// DOMAIN REGISTRY — the closed vocabulary of lib/ domain folders.
//
// lib/ roots are folder-only (a flat file at lib/ root is a lint error), and a
// first-level lib/ subfolder must be one of the names below. This is what stops
// agents inventing junk-drawer folders (lib/misc/, lib/helpers/) or dumping
// files flat instead of picking a domain.
//
// ADDING A NEW DOMAIN is deliberate and cheap: append ONE name to the right
// array below (kebab-case, named after the CONCERN it owns — never a grab-bag
// like "misc"/"common"/"helpers"), and say why in the commit message.
// eslint.config.mjs imports this file. A new MAIN domain also requires an index.ts
// (module public API — enforceExistence applies under main/lib).

/** First-level domains under src/renderer/lib/ (renderer-process logic, by concern). */
export const RENDERER_LIB_DOMAINS = [
  'agent-chat',
  'atoms',
  'audio',
  'code-editor',
  'commands',
  'flow-rehearsal',
  'flows',
  'hooks',
  'hotkeys',
  'mascot',
  'mentions',
  'perf',
  'plugins',
  'query-keys',
  'sentry',
  'stores',
  'tasks',
  'test-utils',
  'themes',
  'tree-navigation',
  'utils',
  'webgl',
  'work-queue',
  'workspace-context',
  'worktree',
];

/**
 * Named root folders of src/main (no generic kebab match at main root). A new
 * root folder needs BOTH a one-line append here AND a named entry in
 * eslint.config.mjs mainStructure (shapes differ per root, so the config entry
 * stays hand-written).
 */
export const MAIN_ROOT_FOLDERS = ['lib', 'windows'];

/** First-level domains under src/main/lib/ (main-process modules, by domain). */
export const MAIN_LIB_DOMAINS = [
  'agent-runner',
  'agents',
  // Per-chat composer settings (model / Auto / Fast / Thinking) main owns for every window + phone.
  'chat-composer',
  'claude',
  'cloud',
  'commands',
  'credentials',
  'custom-nodes',
  'db',
  'debug-ingest',
  'diagnostics',
  'flows',
  'git',
  'integrations',
  'mcp',
  'mobile',
  'permissions',
  'platform',
  'provider',
  'sentry',
  'skills',
  'socket',
  'task-executor',
  'tasks',
  'terminal',
  'test-utils',
  'trpc',
  'webhooks',
  'worktree',
];
