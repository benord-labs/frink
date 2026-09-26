import { memo, useMemo } from 'react';
import {
  FRINK_DYNAMIC_CHAT_MCP_KEY,
  friendlyMcpName,
  parseMcpToolFullName,
} from '../../../../../shared/lib/mcp-tool-name';
import { isPermissionPresentation } from '../../../../../shared/lib/permissions/presentation';
import type { PromptData } from '../../../../../shared/types/permissions';
import { cn } from '../../../../lib/utils';
import { CustomNodeRegistrationPreview } from './CustomNodeRegistrationPreview';
import { PromptContent, type PromptKind } from './PromptContent';

type PromptBodyProps = {
  prompt: PromptData;
  isBash: boolean;
  isFileOpTool: boolean;
  isPathInCurrentProject: boolean;
  projectDisplayName: string;
  requestPath: string;
  paneLinkAccentClass?: string;
};

type PromptKindFlags = {
  isBash: boolean;
  isFileOpTool: boolean;
  isFlowPatch: boolean;
  isMcp: boolean;
};

const PROMPT_HEADER_LABELS: Record<PromptKind, string> = {
  bash: 'Bash',
  file: 'File',
  flow: 'Flow',
  mcp: 'MCP',
  tool: 'Tool',
};

const CUSTOM_NODE_REGISTRATION_TOOL = `mcp__${FRINK_DYNAMIC_CHAT_MCP_KEY}__frink_register_node`;

function promptKind({ isBash, isFileOpTool, isFlowPatch, isMcp }: PromptKindFlags): PromptKind {
  if (isBash) return 'bash';
  if (isFileOpTool) return 'file';
  if (isFlowPatch) return 'flow';
  if (isMcp) return 'mcp';
  return 'tool';
}

/**
 * Header label + body line for the 4-button permission prompt. Branches on
 * tool type:
 *   - File-op  → "Allow <tool> in <project>?"
 *   - MCP      → "Agent wants to use <FriendlyName> (<server>)"
 *   - Bash etc → the command in a bounded, scrollable `<pre>` (full command,
 *                wraps; no truncation)
 */
export const PromptBody = memo(function PromptBody({
  prompt,
  isBash,
  isFileOpTool,
  isPathInCurrentProject,
  projectDisplayName,
  requestPath,
  paneLinkAccentClass,
}: PromptBodyProps) {
  const isMcp = prompt.tool.startsWith('mcp__');
  const parsedMcpName = isMcp ? parseMcpToolFullName(prompt.tool) : null;
  const isFlowPatch = parsedMcpName?.toolName === 'frink_flows_patch';
  const registrationPresentation =
    prompt.tool === CUSTOM_NODE_REGISTRATION_TOOL && isPermissionPresentation(prompt.presentation)
      ? prompt.presentation
      : null;
  const kind = promptKind({
    isBash,
    isFileOpTool,
    isFlowPatch,
    isMcp,
  });
  const showHeader = kind !== 'flow';

  const mcpFriendlyName = useMemo(
    () => (kind === 'mcp' ? friendlyMcpName(prompt.tool) : null),
    [kind, prompt.tool],
  );

  if (registrationPresentation) {
    return (
      <div className="flex items-start gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium py-0.5 shrink-0">
          Custom node
        </span>
        <div className="min-w-0 flex-1">
          <CustomNodeRegistrationPreview presentation={registrationPresentation} />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex items-start', showHeader && 'gap-2')}>
      {showHeader ? (
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium py-0.5 shrink-0">
          {PROMPT_HEADER_LABELS[kind]}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <PromptContent
          kind={kind}
          prompt={prompt}
          isPathInCurrentProject={isPathInCurrentProject}
          projectDisplayName={projectDisplayName}
          requestPath={requestPath}
          paneLinkAccentClass={paneLinkAccentClass}
          mcpFriendlyName={mcpFriendlyName}
        />
      </div>
    </div>
  );
});
