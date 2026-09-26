import log from 'electron-log';
import type { CategoryHandler } from './types';

/** PCH-6 fills this — project hook files to tools that have a hook format (Cursor/Codex/Gemini). */
export const deliverHooks: CategoryHandler = async ({ mode, ctx }) => {
  log.info(`[provider] deliver:hooks ${mode} (stub) → ${ctx.provider} @ ${ctx.projectId}`);
  return { category: 'hooks', mode, status: 'noop', detail: 'not implemented (PCH-6)' };
};

/** PCH-6 fills this — run hooks at the Claude gate where the tool has no hook file. */
export const enforceHooks: CategoryHandler = async ({ mode, ctx }) => {
  log.info(`[provider] enforce:hooks ${mode} (stub) → ${ctx.provider} @ ${ctx.projectId}`);
  return { category: 'hooks', mode, status: 'noop', detail: 'not implemented (PCH-6)' };
};
