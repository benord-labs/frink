/**
 * Arguments of the generic call-tool node: schema-derived fields over the picked tool's projected
 * inputs (the default), or one JSON text (the escape hatch). The stored value's shape is the mode.
 */
import { Button } from '@benord-labs/frink-primitives';
import { type ReactElement, useState } from 'react';
import { z } from 'zod';
import {
  findMissingRequiredCustomNodeInputs,
  type JsonValue,
  type ManifestInputDeclarations,
  parseManifestInputDeclarations,
} from '../../../../../../../shared/lib/flows/custom-node-required-inputs';
import { SchemaFields } from '../../SchemaFields';
import type { ProjectNodeConfigProps } from '../../shared';
import { TemplatableField } from '../../TemplatableField';
import type { PluginTool } from '../ToolPickerField';

const TEXT = z.string();
const JSON_VALUE = z.json();
/** The node's `arguments` object: plain JSON, one entry per tool field. */
const ARGS = z.record(z.string(), JSON_VALUE);
type Args = z.infer<typeof ARGS>;
type ArgValue = Args[string];
const WHOLE_PLACEHOLDER = /^\{\{[^{}]+\}\}$/;

type Draft = { ok: true; value: ArgValue | undefined } | { ok: false };

/** A JSON sub-field saves what parses (or one whole placeholder); blank omits it; anything else stays a draft. */
function parseJsonDraft(text: string): Draft {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  if (WHOLE_PLACEHOLDER.test(trimmed)) return { ok: true, value: trimmed };
  try {
    const parsed = JSON_VALUE.safeParse(JSON.parse(trimmed));
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** The JSON text as an arguments object; blank text is "no arguments". */
function objectFromText(text: string): Args | undefined {
  const draft = parseJsonDraft(text);
  if (!draft.ok) return undefined;
  const object = ARGS.safeParse(draft.value ?? {});
  return object.success ? object.data : undefined;
}

function withKey(args: Args, key: string, value: ArgValue | undefined) {
  const next = { ...args };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

type FieldPatch = { args?: Args; draft?: { key: string; text: string | null } };

/**
 * One form edit: `undefined` unsets the field (a cleared number, an abandoned variable); a JSON
 * sub-field keeps its text as a draft and saves only once it parses; anything else is JSON already.
 */
function fieldPatch(
  args: Args,
  declarations: ManifestInputDeclarations,
  patch: Parameters<ProjectNodeConfigProps['onConfigPatch']>[0],
): FieldPatch {
  const [key, raw] = Object.entries(patch)[0] ?? [];
  if (key === undefined) return {};
  if (raw === undefined) return { args: withKey(args, key, undefined), draft: { key, text: null } };
  const asText = TEXT.safeParse(raw);
  if (declarations[key]?.type === 'json' && asText.success) {
    const draft = parseJsonDraft(asText.data);
    const result: FieldPatch = { draft: { key, text: asText.data } };
    if (draft.ok) result.args = withKey(args, key, draft.value);
    return result;
  }
  const next = JSON_VALUE.safeParse(raw);
  return next.success ? { args: withKey(args, key, next.data) } : {};
}

function applyDraft(drafts: Record<string, string>, draft: { key: string; text: string | null }) {
  const { [draft.key]: _dropped, ...rest } = drafts;
  return draft.text === null ? rest : { ...rest, [draft.key]: draft.text };
}

function ModeSwitch({
  jsonMode,
  canSwitch,
  onSwitch,
}: {
  jsonMode: boolean;
  canSwitch: boolean;
  onSwitch: () => void;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={!canSwitch}
      title={canSwitch ? undefined : 'Make the text a JSON object first.'}
      onClick={onSwitch}
    >
      {jsonMode ? 'Edit as fields' : 'Edit as JSON'}
    </Button>
  );
}

function ArgumentsNotes({
  tool,
  jsonMode,
}: {
  tool: PluginTool | undefined;
  jsonMode: boolean;
}): ReactElement | null {
  if (tool === undefined) {
    return (
      <p className="text-xs text-muted-foreground">
        The tool list is unavailable right now, so the arguments stay as JSON text.
      </p>
    );
  }
  if (jsonMode || tool.unsupportedFields.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Not editable as fields: {tool.unsupportedFields.join(', ')}. Use Edit as JSON to set them.
    </p>
  );
}

type Props = {
  nodeId: string;
  blockType: string;
  /** The picked tool's row; absent while nothing is picked or the server could not be read. */
  tool: PluginTool | undefined;
  value: unknown;
  onConfigPatch: ProjectNodeConfigProps['onConfigPatch'];
};

export function CallToolArguments({
  nodeId,
  blockType,
  tool,
  value,
  onConfigPatch,
}: Props): ReactElement | null {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const fieldId = `custom-node-${nodeId}-arguments`;
  const text = TEXT.safeParse(value);
  const object = ARGS.safeParse(value);
  const args: Args = object.success ? object.data : {};
  // Without the tool's row there is no form to derive, so the JSON text is the only editable shape.
  const jsonMode = text.success || tool === undefined;
  if (tool === undefined && value === undefined) return null;

  // SAFETY: projected inputs arrive as plain JSON over tRPC and are re-parsed before any field is read.
  const declarations = tool ? parseManifestInputDeclarations(tool.inputs as JsonValue) : {};
  const missing =
    tool && !jsonMode
      ? // SAFETY: the arguments object comes out of graph storage, which holds only plain JSON.
        findMissingRequiredCustomNodeInputs(declarations, args as Record<string, JsonValue>)
      : [];
  const textAsObject = text.success ? objectFromText(text.data) : undefined;

  const patchField: ProjectNodeConfigProps['onConfigPatch'] = (patch) => {
    const result = fieldPatch(args, declarations, patch);
    if (result.draft) setDrafts((current) => applyDraft(current, result.draft!));
    if (result.args) onConfigPatch({ arguments: result.args });
  };
  const switchMode = () => {
    // A draft belongs to the fields it was typed into; the round trip re-reads the stored value.
    setDrafts({});
    onConfigPatch({
      arguments: jsonMode ? (textAsObject ?? {}) : JSON.stringify(args, null, 2),
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Arguments
        </p>
        {tool && (
          <ModeSwitch
            jsonMode={jsonMode}
            canSwitch={!jsonMode || textAsObject !== undefined}
            onSwitch={switchMode}
          />
        )}
      </div>

      {missing.length > 0 && (
        <div className="text-warning rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs">
          This tool needs a value for: {missing.join(', ')}.
        </div>
      )}

      {jsonMode || tool === undefined ? (
        <TemplatableField
          fieldId={fieldId}
          label="Arguments"
          type="json"
          value={value}
          onChange={(next) => onConfigPatch({ arguments: next })}
        />
      ) : (
        <SchemaFields
          inputs={tool.inputs}
          values={{ ...args, ...drafts }}
          fieldIdPrefix={fieldId}
          blockType={blockType}
          credentialsReady={false}
          onConfigPatch={patchField}
        />
      )}

      <ArgumentsNotes tool={tool} jsonMode={jsonMode} />
    </div>
  );
}
