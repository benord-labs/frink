/**
 * Shared layout and helpers for block config forms.
 */

import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import type { FlowBlockType } from '../../../../../shared/lib/block-registry';
import type { RunCommandExpectedOutputs } from '../../../../../shared/lib/output-schemas';
import type { FlowNode } from '../../../../../shared/lib/validate-flow-graph';
import type { NodeVariables } from '../../../../../shared/lib/validate-flow-templates';
import type { FlowSettings } from '../../../../../shared/types/flow';
import { Label } from '../../../../components/ui/label';
import { TemplateHighlightContainer } from './shared/TemplateHighlightContainer';

export { isProjectRow } from '../is-project-row';

/**
 * Upstream graph context shared by block config forms — the trigger type and the
 * predecessor chain that AvailableVariables and template hints render from.
 */
export type UpstreamContextProps = {
  triggerBlockType?: FlowBlockType;
  predecessorBlockType?: string | null;
  predecessorOfPredecessorBlockType?: string | null;
  predecessorExpectedOutputs?: RunCommandExpectedOutputs | null;
  predecessorOfPredecessorExpectedOutputs?: RunCommandExpectedOutputs | null;
  ancestorFanOut?: { fanOutNodeId: string; fanOutSourceBlockType: string | null } | null;
  nodeVariables?: NodeVariables | null;
};

/**
 * Common props for project-scoped block config forms (start_task, run_command):
 * the node, flow-level defaults, upstream context, and patch callbacks.
 */
export type ProjectNodeConfigProps = UpstreamContextProps & {
  node: FlowNode;
  flowSettings?: FlowSettings;
  onPatchLabel: (patch: { label?: string }) => void;
  onConfigPatch: (config: Record<string, unknown>) => void;
  /** Opens flow settings focused on the Project field (project-field CTA when nothing is inherited). */
  onOpenFlowSettings?: () => void;
};

/** Normalized `node.config` object for form reads (empty object when missing). */
export function cfg(node: FlowNode): Record<string, unknown> {
  const c = node.config;
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
}

type FieldRowProps = {
  /** Associates the label with the control `id` (hint/error suffixes use this value). */
  htmlFor?: string;
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string | null;
};

export function FieldRow({ htmlFor, label, children, hint, error }: FieldRowProps): ReactElement {
  const hintId =
    htmlFor !== undefined && hint !== undefined && hint !== '' ? `${htmlFor}-hint` : undefined;
  const errorId =
    htmlFor !== undefined && error !== undefined && error !== null && error !== ''
      ? `${htmlFor}-error`
      : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  let enhancedChild = children;
  if (htmlFor !== undefined && Children.count(children) === 1) {
    const onlyChild = Children.only(children);
    if (isValidElement(onlyChild)) {
      const isHighlight =
        onlyChild.type === TemplateHighlightContainer ||
        (onlyChild.type as { displayName?: string } | undefined)?.displayName ===
          'TemplateHighlightContainer';
      if (isHighlight) {
        enhancedChild = cloneElement(
          onlyChild as ReactElement<{ textareaId?: string }>,
          {
            textareaId: htmlFor,
            'aria-invalid': error ? true : undefined,
            ...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {}),
          } as Record<string, unknown>,
        );
      } else {
        enhancedChild = cloneElement(onlyChild, {
          id: (onlyChild.props as { id?: string }).id ?? htmlFor,
          'aria-invalid': error ? true : undefined,
          ...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {}),
        } as Partial<unknown>);
      }
    }
  }

  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
      </Label>
      {enhancedChild}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
