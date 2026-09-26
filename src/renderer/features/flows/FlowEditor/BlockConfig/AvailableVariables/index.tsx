/* eslint-disable max-lines-per-function */
/**
 * "Available Variables" reference panel shown inside block config forms.
 *
 * Displays `{{trigger.*}}`, `{{previous.*}}`, and `{{loop.*}}` variables
 * accessible in template fields. (The flow briefing is delivered to every agent
 * as a system prompt, so there is no `{{flow.*}}` chip to reference.)
 *
 * Clicking a variable chip copies its template syntax to the clipboard.
 */

import { Button } from '@benord-labs/frink-primitives';
import { ChevronDown, ChevronRight, ClipboardCheck, Copy } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import {
  LOOP_CONTEXT_SCHEMA,
  type ManifestOutputField,
  manifestOutputsToSchema as manifestFieldsToOutputSchema,
  OUTPUT_SCHEMAS,
  type OutputFieldSchema,
  type RunCommandExpectedOutputs,
  TRIGGER_ALLOWS_ARBITRARY_KEYS,
  TRIGGER_SCHEMAS,
  type TriggerFieldSchema,
} from '../../../../../../shared/lib/output-schemas';
import type { NodeVariables } from '../../../../../../shared/lib/validate-flow-templates';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../../../../components/ui/tooltip';
import { trpc } from '../../../../../lib/trpc';
import { cn } from '../../../../../lib/utils';
import {
  BLOCK_CONFIG_CALLOUT_CLASS,
  BLOCK_CONFIG_COLLAPSIBLE_SHELL_CLASS,
} from '../block-config-chrome';
import {
  type CustomNodeSchema,
  getOutputSchemaForBlockType,
} from '../shared/output-variable-schema';

function manifestOutputsToSchema(outputs: Record<string, ManifestOutputField>): CustomNodeSchema {
  const topLevelFields = manifestFieldsToOutputSchema(outputs);

  // Prefer the field named 'items' for currentItem sub-fields, since fan_out defaults to
  // config.arrayField = 'items'. Fall back to the first array-typed field if 'items' absent.
  const preferredArrayEntry =
    outputs.items?.type === 'array'
      ? (['items', outputs.items] as const)
      : Object.entries(outputs).find(([, f]) => f.type === 'array');

  let currentItemSubFields: OutputFieldSchema[] | undefined;
  let currentItemIsPrimitive: boolean | undefined;

  if (preferredArrayEntry) {
    const [, field] = preferredArrayEntry;
    if (field.items && Object.keys(field.items).length > 0) {
      currentItemSubFields = manifestFieldsToOutputSchema(field.items);
    } else {
      currentItemIsPrimitive = true;
    }
  }

  return { topLevelFields, currentItemSubFields, currentItemIsPrimitive };
}

/**
 * Resolves custom node output schemas from the cached trpc.customNodes.list query.
 * Returns null for built-in block types (fall back to OUTPUT_SCHEMAS / CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA).
 * Returns null for custom nodes without declared outputs (fall back to CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA).
 * React Query deduplicates the query — the NodeCreatorPanel already fetches this with the same key.
 */
function useCustomNodeOutputSchema(blockType: string | null | undefined): CustomNodeSchema | null {
  const { data: customNodes } = trpc.customNodes.list.useQuery(undefined, { staleTime: 30_000 });

  if (!blockType || blockType in OUTPUT_SCHEMAS) return null;

  const node = customNodes?.find((n) => n.name === blockType);
  const outputs = node?.outputs as Record<string, ManifestOutputField> | undefined;
  if (!outputs || Object.keys(outputs).length === 0) return null;

  return manifestOutputsToSchema(outputs);
}

type Props = {
  /** Block type of the flow's trigger node — determines which `{{trigger.*}}` fields to show. */
  triggerBlockType?: string | null;
  /**
   * Block type of the immediate predecessor node — determines which `{{previous.*}}` fields
   * to show. Null when the node directly follows the trigger (no previous block outputs).
   */
  predecessorBlockType?: string | null;
  /**
   * Block type two hops upstream. When predecessorBlockType is `fan_out`, this is the node
   * whose output fields become `{{previous.currentItem.*}}` chips.
   * When predecessorBlockType is `condition`, this is the node that condition passes through.
   */
  predecessorOfPredecessorBlockType?: string | null;
  /**
   * `expectedOutputs` from the immediate predecessor's config (only meaningful when
   * predecessorBlockType is `run_command`). When present, shows declared JSON stdout fields
   * as chips instead of the generic dynamic-output fallback.
   */
  predecessorExpectedOutputs?: RunCommandExpectedOutputs | null;
  /**
   * `expectedOutputs` from two hops upstream (only meaningful when predecessorBlockType is
   * `condition` and the node before the condition is `run_command`).
   */
  predecessorOfPredecessorExpectedOutputs?: RunCommandExpectedOutputs | null;
  /**
   * Nearest ancestor fan_out node when this node is inside a fan_out body chain.
   * When set, renders a LOOP section with `{{loop.currentItem.*}}` and `{{loop.currentIndex}}` chips.
   */
  ancestorFanOut?: { fanOutNodeId: string; fanOutSourceBlockType: string | null } | null;
  /**
   * When set, `previous.*` and `trigger.*` chip lists match `computeNodeVariables` (same as flow validation).
   * Fan-out `currentItem.*` and `loop.*` item fields still use manifest / graph props below.
   */
  nodeVariables?: NodeVariables | null;
};

function VariableChip({
  variable,
  description,
}: {
  variable: string;
  description: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(variable).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          onClick={handleCopy}
          aria-label={`Copy ${variable} to clipboard${copied ? ' — copied' : ''}`}
          className="group h-auto min-h-7 gap-1 rounded-md border border-border/45 bg-card/40 px-2 py-1.5 font-mono text-xs font-normal shadow-xs ring-1 ring-inset ring-border/25 hover:border-border/70 hover:bg-card/55"
        >
          <span aria-hidden>{variable}</span>
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {copied ? 'Copied to clipboard' : ''}
          </span>
          {copied ? (
            <ClipboardCheck className="h-3 w-3 shrink-0 text-green-500" aria-hidden />
          ) : (
            <Copy
              className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              aria-hidden
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <span>{description}</span>
      </TooltipContent>
    </Tooltip>
  );
}

type SectionProps = {
  title: string;
  fields: Array<{ variable: string; description: string; guaranteed: boolean }>;
  note?: string;
};

function VariableSection({ title, fields, note }: SectionProps): ReactElement {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {fields.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {fields.map(({ variable, description, guaranteed }) => (
            <VariableChip
              key={variable}
              variable={variable}
              description={`${description}${guaranteed ? '' : ' (not always present)'}`}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">No fields available</p>
      )}
      {note && <p className={cn(BLOCK_CONFIG_CALLOUT_CLASS, 'leading-snug')}>{note}</p>}
    </div>
  );
}

function getTriggerFields(triggerBlockType: string): {
  fields: TriggerFieldSchema[];
  note?: string;
} {
  const fields = TRIGGER_SCHEMAS[triggerBlockType] ?? [];
  if (TRIGGER_ALLOWS_ARBITRARY_KEYS.has(triggerBlockType)) {
    return {
      fields,
      note: 'Any key passed via triggerContext in frink_flows_run or define_stages is also available as {{trigger.<key>}} (e.g. workstreamId, storyId). Keys are auto-declared in Flow Settings → Batch trigger variables.',
    };
  }
  return { fields };
}

export function AvailableVariables({
  triggerBlockType,
  predecessorBlockType,
  predecessorOfPredecessorBlockType,
  predecessorExpectedOutputs,
  predecessorOfPredecessorExpectedOutputs,
  ancestorFanOut,
  nodeVariables,
}: Props): ReactElement | null {
  const [open, setOpen] = useState(false);

  // Resolve custom node schemas (deduped via React Query — same key as NodeCreatorPanel)
  const predecessorCustomSchema = useCustomNodeOutputSchema(predecessorBlockType);
  const fanOutSourceCustomSchema = useCustomNodeOutputSchema(predecessorOfPredecessorBlockType);
  const loopSourceCustomSchema = useCustomNodeOutputSchema(ancestorFanOut?.fanOutSourceBlockType);

  const hasTriggerFields = !!triggerBlockType;
  const hasPreviousFields = predecessorBlockType != null;
  const hasLoopContext = !!ancestorFanOut;

  if (!hasTriggerFields && !hasPreviousFields && !hasLoopContext) return null;

  const triggerFields =
    triggerBlockType && nodeVariables != null
      ? (() => {
          const base = getTriggerFields(triggerBlockType);
          return {
            fields: nodeVariables.trigger.length > 0 ? nodeVariables.trigger : base.fields,
            note: base.note,
          };
        })()
      : triggerBlockType
        ? getTriggerFields(triggerBlockType)
        : { fields: [] as TriggerFieldSchema[], note: undefined as string | undefined };

  const previousResult =
    predecessorBlockType != null
      ? (() => {
          const schemaExtras = getOutputSchemaForBlockType(predecessorBlockType, {
            fanOutSourceBlockType: predecessorOfPredecessorBlockType,
            customNodeSchema: predecessorCustomSchema,
            fanOutSourceCustomNodeSchema: fanOutSourceCustomSchema,
            expectedOutputs: predecessorExpectedOutputs,
            fanOutSourceExpectedOutputs: predecessorOfPredecessorExpectedOutputs,
          });
          if (nodeVariables != null) {
            const fromNotes = nodeVariables.notes.length > 0 ? nodeVariables.notes.join(' ') : '';
            const mergedNote = [schemaExtras.note, fromNotes].filter(Boolean).join(' ');
            return {
              fields: nodeVariables.previous,
              currentItemFields: schemaExtras.currentItemFields,
              currentItemIsPrimitive: schemaExtras.currentItemIsPrimitive,
              note: mergedNote || undefined,
            };
          }
          return schemaExtras;
        })()
      : null;

  const previousFields =
    previousResult?.fields.map((f) => ({
      variable: `{{previous.${f.key}}}`,
      description: f.description,
      guaranteed: f.guaranteed,
    })) ?? [];

  const currentItemFields =
    previousResult?.currentItemFields?.map((f) => ({
      variable: `{{previous.currentItem.${f.key}}}`,
      description: f.description,
      guaranteed: f.guaranteed,
    })) ?? [];

  const triggerFieldsMapped = triggerFields.fields.map((f) => ({
    variable: `{{trigger.${f.key}}}`,
    description: f.description,
    guaranteed: true,
  }));

  const showDynamicCurrentItemNote =
    predecessorBlockType === 'fan_out' &&
    currentItemFields.length === 0 &&
    !previousResult?.currentItemIsPrimitive;

  // LOOP section — available when inside a fan_out body chain
  const loopScalarFields = LOOP_CONTEXT_SCHEMA.map((f) => ({
    variable: `{{loop.${f.key}}}`,
    description: f.description,
    guaranteed: f.guaranteed,
  }));

  // Resolve {{loop.currentItem.*}} from the fan_out's source block type
  let loopItemFields: Array<{ variable: string; description: string; guaranteed: boolean }> = [];
  let loopItemNote: string | undefined;
  if (ancestorFanOut) {
    const src = ancestorFanOut.fanOutSourceBlockType;
    if (loopSourceCustomSchema) {
      if (loopSourceCustomSchema.currentItemIsPrimitive) {
        loopItemNote = 'Array of primitives — use {{loop.currentItem}} directly.';
      } else if (loopSourceCustomSchema.currentItemSubFields?.length) {
        loopItemFields = loopSourceCustomSchema.currentItemSubFields.map((f) => ({
          variable: `{{loop.currentItem.${f.key}}}`,
          description: f.description,
          guaranteed: f.guaranteed,
        }));
      } else {
        loopItemFields = loopSourceCustomSchema.topLevelFields.map((f) => ({
          variable: `{{loop.currentItem.${f.key}}}`,
          description: f.description,
          guaranteed: f.guaranteed,
        }));
        loopItemNote = "Iterating over this node's top-level outputs.";
      }
    } else if (src && src in OUTPUT_SCHEMAS && src !== 'run_command') {
      loopItemFields = (OUTPUT_SCHEMAS[src] ?? []).map((f) => ({
        variable: `{{loop.currentItem.${f.key}}}`,
        description: f.description,
        guaranteed: f.guaranteed,
      }));
    } else {
      loopItemNote =
        'The upstream node outputs dynamic JSON — use {{loop.currentItem.<field>}} with the actual field names. Declare an "outputs" schema in the manifest to see specific chips.';
    }
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className={BLOCK_CONFIG_COLLAPSIBLE_SHELL_CLASS}>
        <Button
          variant="ghost"
          size="auto"
          onClick={() => setOpen((v) => !v)}
          className="w-full justify-start text-left font-normal flex gap-1.5 rounded-none px-3 py-2.5 text-sm text-muted-foreground hover:bg-transparent hover:text-foreground"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          Available variables
        </Button>

        {open && (
          <div className="space-y-4 border-t border-border/40 px-3 pb-3 pt-3">
            <p className="text-xs text-muted-foreground/70">
              Click a variable to copy it. Hover for a description.
            </p>

            {(triggerFieldsMapped.length > 0 || triggerFields.note) && (
              <VariableSection
                title="trigger"
                fields={triggerFieldsMapped}
                note={triggerFields.note}
              />
            )}

            {previousResult && (
              <VariableSection
                title={
                  predecessorBlockType === 'condition' && predecessorOfPredecessorBlockType
                    ? `previous (condition via ${predecessorOfPredecessorBlockType})`
                    : `previous (${predecessorBlockType})`
                }
                fields={previousFields}
                note={predecessorBlockType === 'fan_out' ? undefined : previousResult.note}
              />
            )}

            {currentItemFields.length > 0 && (
              <VariableSection
                title={`currentItem fields (from ${predecessorOfPredecessorBlockType ?? 'upstream'})`}
                fields={currentItemFields}
                note="Each iteration gets one item from the array. Use these to access its fields."
              />
            )}

            {previousResult?.currentItemIsPrimitive && predecessorBlockType === 'fan_out' && (
              <VariableSection
                title="currentItem (primitives)"
                fields={[]}
                note={
                  previousResult.note ??
                  'The upstream array contains primitive values — use {{previous.currentItem}} directly.'
                }
              />
            )}

            {showDynamicCurrentItemNote && (
              <VariableSection
                title="currentItem fields (dynamic)"
                fields={[]}
                note={
                  previousResult?.note ??
                  'The upstream node outputs dynamic JSON — use {{previous.currentItem.<field>}} with the actual field names from your script output. Add an "outputs" declaration to the node\'s manifest.json to see specific field chips here.'
                }
              />
            )}

            {hasLoopContext && (
              <>
                <VariableSection
                  title="loop (iteration context)"
                  fields={loopScalarFields}
                  note="Available on every node inside a fan_out body. currentIndex is zero-based."
                />
                {(loopItemFields.length > 0 || loopItemNote) && (
                  <VariableSection
                    title={`loop.currentItem fields (from ${ancestorFanOut?.fanOutSourceBlockType ?? 'upstream'})`}
                    fields={loopItemFields}
                    note={loopItemNote ?? 'One item per iteration from the fan_out source array.'}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
