import { isCustomNodeBlockType } from '../block-registry';
import {
  isTemplateRenderedInput,
  type ManifestInputDeclarations,
} from './custom-node-required-inputs';

const TEMPLATE_RENDERED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  run_command: ['command', 'projectId'],
  start_task: ['label', 'branch', 'projectId'],
  agent: ['instructions', 'agentInstructions'],
};

/** Fields rendered as Flow templates at runtime; `declarations` drop `"template": false` inputs. */
export function getTemplateRenderedFields(
  blockType: string,
  config: Record<string, unknown> | undefined,
  declarations?: ManifestInputDeclarations,
): readonly string[] {
  if (blockType === 'chat_reply') {
    return config?.contentType === 'html_artifact'
      ? ['artifactTitleTemplate', 'artifactBodyHtmlTemplate']
      : ['messageTemplate'];
  }
  const builtInFields = TEMPLATE_RENDERED_FIELDS[blockType];
  if (builtInFields) return builtInFields;
  if (!isCustomNodeBlockType(blockType) || !config) return [];
  // Every top-level key except projectId (read statically) and inputs the manifest opts out.
  return Object.keys(config).filter(
    (field) => field !== 'projectId' && isTemplateRenderedInput(declarations?.[field]),
  );
}
