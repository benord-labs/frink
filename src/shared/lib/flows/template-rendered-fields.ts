import { isCustomNodeBlockType } from '../block-registry';

const TEMPLATE_RENDERED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  run_command: ['command', 'projectId'],
  start_task: ['label', 'branch', 'projectId'],
  agent: ['instructions', 'agentInstructions'],
};

/** Fields whose string values are rendered as Flow templates at runtime. */
export function getTemplateRenderedFields(
  blockType: string,
  config: Record<string, unknown> | undefined,
): readonly string[] {
  if (blockType === 'chat_reply') {
    return config?.contentType === 'html_artifact'
      ? ['artifactTitleTemplate', 'artifactBodyHtmlTemplate']
      : ['messageTemplate'];
  }
  const builtInFields = TEMPLATE_RENDERED_FIELDS[blockType];
  if (builtInFields) return builtInFields;
  if (!isCustomNodeBlockType(blockType) || !config) return [];
  // Every top-level key except projectId, which custom-node dispatch reads statically. Callers
  // only ask about values they have already narrowed to strings, so no value check is needed.
  return Object.keys(config).filter((field) => field !== 'projectId');
}
