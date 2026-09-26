import { z } from 'zod';

const chatReplyTemplateConfigSchema = z
  .object({
    contentType: z.enum(['text', 'html_artifact']).optional().catch(undefined),
    messageTemplate: z.string().optional().catch(undefined),
    artifactTitleTemplate: z.string().optional().catch(undefined),
    artifactBodyHtmlTemplate: z.string().optional().catch(undefined),
  })
  .catch({});
const chatReplyLoopIndexSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

type ChatReplyTemplateConfigInput = Parameters<typeof chatReplyTemplateConfigSchema.parse>[0];
type ChatReplyLoopIndexInput = Parameters<typeof chatReplyLoopIndexSchema.safeParse>[0];
export type ChatReplyTemplateConfig = z.output<typeof chatReplyTemplateConfigSchema>;

export function parseChatReplyTemplateConfig(
  config: ChatReplyTemplateConfigInput,
): ChatReplyTemplateConfig {
  return chatReplyTemplateConfigSchema.parse(config);
}

export function chatReplyTemplateWarnings(config: ChatReplyTemplateConfigInput): string[] {
  const parsed = parseChatReplyTemplateConfig(config);
  const requirements =
    parsed.contentType === 'html_artifact'
      ? [
          [parsed.artifactTitleTemplate, 'artifact title'],
          [parsed.artifactBodyHtmlTemplate, 'artifact body HTML'],
        ]
      : [[parsed.messageTemplate, 'message']];
  return requirements.flatMap(([template, label]) =>
    template?.trim() ? [] : [`has no ${label} template`],
  );
}

export function createChatReplyArtifactId(
  flowRunId: string,
  nodeId: string,
  loopIndex: ChatReplyLoopIndexInput,
): string {
  const baseId = `${flowRunId}:${nodeId}`;
  const parsedLoopIndex = chatReplyLoopIndexSchema.safeParse(loopIndex);
  return parsedLoopIndex.success ? `${baseId}:loop:${parsedLoopIndex.data}` : baseId;
}
