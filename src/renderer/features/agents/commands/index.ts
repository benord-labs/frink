import { lazy } from 'react';

export { COMMAND_PROMPTS } from '@/lib/commands/builtin-commands';
export type { SlashCommandOption } from '@/lib/commands/types';
export { AgentsSlashCommand, SLASH_COMMAND_LISTBOX_ID } from './agents-slash-command';

/** Lazy-loaded modal — only fetched when the user opens the command editor */
export const LazyCommandEditorModal = lazy(() =>
  import('./command-editor-modal').then((m) => ({ default: m.CommandEditorModal })),
);
