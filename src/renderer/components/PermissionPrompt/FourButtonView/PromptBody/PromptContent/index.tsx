import { memo, type ReactElement } from 'react';
import type { friendlyMcpName } from '../../../../../../shared/lib/mcp-tool-name';
import type { PromptData } from '../../../../../../shared/types/permissions';
import { vendorPluginMcpTitle } from '../../../../dialogs/settings-tabs/AgentsMcpTab/constants';
import { cn } from '../../../../../lib/utils';
import { FlowPatchSummary } from '../FlowPatchSummary';

export type PromptKind = 'bash' | 'file' | 'flow' | 'mcp' | 'tool';

type FriendlyMcpName = NonNullable<ReturnType<typeof friendlyMcpName>>;

type Props = {
  kind: PromptKind;
  prompt: PromptData;
  isPathInCurrentProject: boolean;
  projectDisplayName: string;
  requestPath: string;
  paneLinkAccentClass?: string;
  mcpFriendlyName: FriendlyMcpName | null;
};

type FilePromptProps = Pick<
  Props,
  'prompt' | 'isPathInCurrentProject' | 'projectDisplayName' | 'requestPath' | 'paneLinkAccentClass'
>;

function RequestPath({ value }: { value: string }): ReactElement | null {
  if (!value) return null;
  return (
    <p className="text-[10px] text-muted-foreground mt-0.5 overflow-x-auto whitespace-nowrap">
      {value}
    </p>
  );
}

function FileQuestion({
  prompt,
  isPathInCurrentProject,
  projectDisplayName,
  paneLinkAccentClass,
}: Omit<FilePromptProps, 'requestPath'>): ReactElement {
  const toolName = prompt.tool.toLowerCase();

  if (!isPathInCurrentProject) {
    return (
      <span className="text-xs text-foreground leading-relaxed">
        Allow <strong>{toolName}</strong> for an external path?
      </span>
    );
  }

  return (
    <span className="text-xs text-foreground leading-relaxed">
      Allow <strong>{toolName}</strong> in{' '}
      <span className={cn('font-mono', paneLinkAccentClass ?? 'text-primary')}>
        {projectDisplayName}
      </span>
      ?
    </span>
  );
}

function FilePrompt(props: FilePromptProps): ReactElement {
  return (
    <>
      <FileQuestion
        prompt={props.prompt}
        isPathInCurrentProject={props.isPathInCurrentProject}
        projectDisplayName={props.projectDisplayName}
        paneLinkAccentClass={props.paneLinkAccentClass}
      />
      <RequestPath value={props.requestPath} />
    </>
  );
}

function McpPrompt({ name }: { name: FriendlyMcpName }): ReactElement {
  return (
    <span className="text-xs text-foreground leading-relaxed">
      Agent wants to use <strong>{name.tool}</strong>
      {name.server ? (
        <code className="ml-1 text-[10px] font-mono text-muted-foreground" title={name.server}>
          ({vendorPluginMcpTitle(name.server) ?? name.server})
        </code>
      ) : null}
    </span>
  );
}

function CommandPrompt({ command }: { command: string }): ReactElement {
  return (
    <pre className="text-xs font-mono text-foreground bg-muted rounded px-2 py-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap wrap-break-word leading-relaxed">
      {command}
    </pre>
  );
}

export const PromptContent = memo(function PromptContent({
  kind,
  prompt,
  isPathInCurrentProject,
  projectDisplayName,
  requestPath,
  paneLinkAccentClass,
  mcpFriendlyName,
}: Props): ReactElement {
  switch (kind) {
    case 'file':
      return (
        <FilePrompt
          prompt={prompt}
          isPathInCurrentProject={isPathInCurrentProject}
          projectDisplayName={projectDisplayName}
          requestPath={requestPath}
          paneLinkAccentClass={paneLinkAccentClass}
        />
      );
    case 'flow':
      return <FlowPatchSummary input={prompt.input} />;
    case 'mcp':
      if (mcpFriendlyName) return <McpPrompt name={mcpFriendlyName} />;
      return <CommandPrompt command={requestPath} />;
    default:
      return <CommandPrompt command={requestPath} />;
  }
});
