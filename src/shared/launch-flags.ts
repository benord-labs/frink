/**
 * 0.0.6 launch flags — surfaces hidden until they're ready to ship as paid
 * features. Flip a flag back to `true` (or remove the gate at the call site)
 * once the corresponding feature is launch-ready.
 */
export const LAUNCH_FLAGS = {
  flows: true,
  workQueue: true,
  /**
   * Vendor plugins staged into chat sessions (sc-1831/sc-2068). The auto-mode
   * vendor deny floor guards writes; flip off to retire the surface in one line.
   */
  vendorClaudePlugins: true,
  /**
   * OpenAI Codex as a selectable AI-account provider. ON (dev): the codex
   * app-server runner + executor branch shipped. When false, codex can't be
   * added and any existing codex
   * row is hidden from selection reads (listAccounts, getResolvedAccount) while
   * write/sync/dedup paths still see it (so a hidden account isn't duplicated or
   * re-defaulted). Auth is passthrough — Frink never stores an OpenAI key.
   * Prod-gating before this leaves dev: live e2e (sc-927) + cross-machine codex
   * routing (a codex chat must not run on a machine without codex installed).
   */
  codexAccounts: true,
  /**
   * Fable 5 model availability. ON — `claude-fable-5` is available again after
   * Anthropic's temporary pull (US-government concerns). Kept as a one-flag
   * kill-switch because availability is externally controlled and has been
   * pulled before: flip to `false` and Fable 5 is filtered out of
   * `CLAUDE_CODE_MODELS` (src/shared/lib/models.ts) so it vanishes from every
   * picker (chat, flows, settings) and can't execute — the catalog fallback
   * coerces a saved selection to Sonnet, definition stays intact.
   */
  fable5: true,
  /**
   * Interactive HTML artifacts returned by a Flow Chat Reply (sc-1741). ON — a
   * one-flag kill-switch, because the artifact body is generated HTML running in
   * a native guest view. When false the "Reply type" selector is hidden, an
   * interactive reply fails run-mode graph validation and errors at dispatch, an
   * already-delivered artifact shows its title as inert text, and no
   * WebContentsView or artifact IPC handler is registered. Nothing is deleted.
   * Gate placement + why the generated skill text stays flag-blind:
   * docs/decisions/flow-html-artifact-preview-boundary.md.
   */
  flowHtmlArtifacts: true,
} as const;
