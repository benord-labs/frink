/**
 * Chat Reply block configuration.
 * Posts a templated message into the originating chat session.
 */

import { Input, Textarea } from '@benord-labs/frink-primitives';
import type { ReactElement } from 'react';
import {
  type ChatReplyTemplateConfig,
  parseChatReplyTemplateConfig,
} from '../../../../../../shared/lib/flows/chat-reply-contract';
import { LAUNCH_FLAGS } from '../../../../../../shared/launch-flags';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select';
import { AvailableVariables } from '../AvailableVariables';
import { cfg, FieldRow, type UpstreamContextProps } from '../shared';
import { TemplateHighlightContainer } from '../shared/TemplateHighlightContainer';

type Props = UpstreamContextProps & {
  node: FlowNode;
  customNodesLoading?: boolean;
  predecessorIsCustomNode?: boolean;
  onPatchLabel: (patch: { label?: string }) => void;
  onConfigPatch: (config: Record<string, unknown>) => void;
};

type ReplyFieldProps = Pick<
  Props,
  'customNodesLoading' | 'predecessorIsCustomNode' | 'nodeVariables' | 'onConfigPatch'
> & { config: ChatReplyTemplateConfig };

function TextReplyField({
  config,
  nodeVariables,
  customNodesLoading,
  predecessorIsCustomNode,
  onConfigPatch,
}: ReplyFieldProps): ReactElement {
  const value = config.messageTemplate ?? '';
  const error = value.trim() === '' ? 'Message template is required.' : null;
  return (
    <FieldRow
      htmlFor="flow-chat-reply-template"
      label="Message template"
      hint="Supports {{trigger.*}} and {{previous.*}} variables."
      error={error}
    >
      <TemplateHighlightContainer
        value={value}
        nodeVariables={nodeVariables}
        customNodesLoading={customNodesLoading}
        predecessorIsCustomNode={predecessorIsCustomNode}
      >
        <Textarea
          id="flow-chat-reply-template"
          value={value}
          onChange={(event) => onConfigPatch({ messageTemplate: event.target.value })}
          placeholder="Task {{trigger.taskTitle}} finished with status: {{trigger.taskStatus}}"
          rows={4}
          className={error ? 'border-destructive' : undefined}
        />
      </TemplateHighlightContainer>
    </FieldRow>
  );
}

function ArtifactReplyFields({
  config,
  nodeVariables,
  customNodesLoading,
  predecessorIsCustomNode,
  onConfigPatch,
}: ReplyFieldProps): ReactElement {
  const title = config.artifactTitleTemplate ?? '';
  const bodyHtml = config.artifactBodyHtmlTemplate ?? '';
  const titleError = title.trim() === '' ? 'Artifact title template is required.' : null;
  const bodyHtmlError = bodyHtml.trim() === '' ? 'Artifact body HTML template is required.' : null;
  return (
    <>
      <FieldRow
        htmlFor="flow-chat-reply-artifact-title"
        label="Artifact title"
        hint="Compact title shown in chat before the artifact runs."
        error={titleError}
      >
        <TemplateHighlightContainer
          value={title}
          nodeVariables={nodeVariables}
          customNodesLoading={customNodesLoading}
          predecessorIsCustomNode={predecessorIsCustomNode}
        >
          <Input
            id="flow-chat-reply-artifact-title"
            value={title}
            onChange={(event) => onConfigPatch({ artifactTitleTemplate: event.target.value })}
            placeholder="Interactive build report"
          />
        </TemplateHighlightContainer>
      </FieldRow>
      <FieldRow
        htmlFor="flow-chat-reply-artifact-body-html"
        label="View body HTML"
        hint="HTML body fragment (max 65,536 bytes). Charts need visible labels and a text or table alternative. Network, navigation, downloads, and permissions are disabled."
        error={bodyHtmlError}
      >
        <TemplateHighlightContainer
          value={bodyHtml}
          nodeVariables={nodeVariables}
          customNodesLoading={customNodesLoading}
          predecessorIsCustomNode={predecessorIsCustomNode}
        >
          <Textarea
            id="flow-chat-reply-artifact-body-html"
            value={bodyHtml}
            onChange={(event) => onConfigPatch({ artifactBodyHtmlTemplate: event.target.value })}
            placeholder={
              '<section aria-labelledby="report-title"><h1 id="report-title">Weekly report</h1></section>'
            }
            rows={10}
            className={`font-mono text-xs ${bodyHtmlError ? 'border-destructive' : ''}`}
          />
        </TemplateHighlightContainer>
      </FieldRow>
    </>
  );
}

export function ChatReplyConfig({
  node,
  triggerBlockType,
  predecessorBlockType,
  predecessorOfPredecessorBlockType,
  predecessorExpectedOutputs,
  predecessorOfPredecessorExpectedOutputs,
  ancestorFanOut,
  nodeVariables,
  customNodesLoading = false,
  predecessorIsCustomNode = false,
  onPatchLabel,
  onConfigPatch,
}: Props): ReactElement {
  const c = parseChatReplyTemplateConfig(cfg(node));
  const contentType = c.contentType ?? 'text';
  const replyFieldProps = {
    config: c,
    nodeVariables,
    customNodesLoading,
    predecessorIsCustomNode,
    onConfigPatch,
  };

  return (
    <div className="space-y-4">
      <FieldRow htmlFor="flow-chat-reply-label" label="Display name" hint="Shown in the step list.">
        <Input
          id="flow-chat-reply-label"
          value={node.label ?? ''}
          onChange={(e) => onPatchLabel({ label: e.target.value })}
          placeholder="Chat reply"
        />
      </FieldRow>
      {LAUNCH_FLAGS.flowHtmlArtifacts && (
        <FieldRow htmlFor="flow-chat-reply-content-type" label="Reply type">
          <Select
            value={contentType}
            onValueChange={(value) => {
              if (value === 'text' || value === 'html_artifact')
                onConfigPatch({ contentType: value });
            }}
          >
            <SelectTrigger id="flow-chat-reply-content-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">Text message</SelectItem>
              <SelectItem value="html_artifact">Interactive view</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
      )}
      {LAUNCH_FLAGS.flowHtmlArtifacts && contentType === 'html_artifact' ? (
        <ArtifactReplyFields {...replyFieldProps} />
      ) : (
        <TextReplyField {...replyFieldProps} />
      )}
      <AvailableVariables
        triggerBlockType={triggerBlockType}
        predecessorBlockType={predecessorBlockType}
        predecessorOfPredecessorBlockType={predecessorOfPredecessorBlockType}
        predecessorExpectedOutputs={predecessorExpectedOutputs}
        predecessorOfPredecessorExpectedOutputs={predecessorOfPredecessorExpectedOutputs}
        ancestorFanOut={ancestorFanOut}
        nodeVariables={nodeVariables}
      />
      <p className="text-xs text-muted-foreground">
        Posts into the flow chat. Requires a Post-Task trigger (chat from the completed task) or an
        upstream Start Task on the same path so a chat session exists.
      </p>
    </div>
  );
}
