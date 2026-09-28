import { findBlankPathShellTemplateWarnings } from './blank-path';
import { findQuotedShellTemplateWarnings } from './quote-context';

/** The shell-specific fields a run_command template warning may carry. */
export type ShellWarningFields = {
  shellQuoteContext?: 'single' | 'double' | 'uncertain';
  /** A placeholder beside a `/`: a blank value collapses the path (sc-3170). */
  shellHazard?: 'blank-path';
};

type ShellTemplateNode = Parameters<typeof findQuotedShellTemplateWarnings>[0][number];

/** Every design-time run_command shell advisory: quote context, then blank-path hazards. */
export function findShellTemplateWarnings(nodes: ShellTemplateNode[]) {
  return [...findQuotedShellTemplateWarnings(nodes), ...findBlankPathShellTemplateWarnings(nodes)];
}
