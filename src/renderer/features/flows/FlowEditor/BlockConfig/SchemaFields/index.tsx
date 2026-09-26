/**
 * SchemaFields
 * Renders a manifest-style inputs map ({type, required, default, label,
 * placeholder, description, options, listOptions}) as a stack of TemplatableFields. Shared by
 * CustomNodeConfig and any config surface whose fields derive from a
 * JSON-schema projection (`json-schema-to-manifest-inputs`).
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select';
import { FieldRow } from '../shared';
import { TemplatableField } from '../TemplatableField';
import { DynamicSelectField } from '../CustomNodeConfig/DynamicSelectField';

export type ManifestInput = {
  type?: string;
  required?: boolean;
  default?: unknown;
  label?: string;
  placeholder?: string;
  /** What the input means, in the provider's own words — rendered in full as help text under the field. */
  description?: string;
  /** Fixed choices (a projected JSON-schema enum) in their JSON type — rendered without any script. */
  options?: Array<string | number | boolean>;
  listOptions?: boolean;
};

type EnumOption = string | number | boolean;

type StaticSelectProps = {
  fieldId: string;
  label: string;
  options: EnumOption[];
  /** Index of the SAVED value among the options; -1 when nothing is saved (a default is never a pick). */
  selectedIndex: number;
  /** The schema default, applied by the tool itself when the argument is omitted — shown, never saved. */
  defaultOption?: EnumOption;
  placeholder?: string;
  description?: string;
  required?: boolean;
  /** Receives the option in its JSON type, so a numeric enum dispatches a number. */
  onChange: (value: EnumOption) => void;
};

function StaticSelectField({
  fieldId,
  label,
  options,
  selectedIndex: selected,
  defaultOption,
  placeholder,
  description,
  required,
  onChange,
}: StaticSelectProps) {
  // Items carry the option INDEX (Radix reserves "" and no member text can collide with an index);
  // only a SAVED value renders selected — an omitted argument lets the tool apply its own default.
  const hasDefault = defaultOption !== undefined;
  return (
    <FieldRow
      htmlFor={fieldId}
      label={label}
      hint={description}
      error={required && selected === -1 && !hasDefault ? `${label} is required.` : undefined}
    >
      <Select
        value={selected === -1 ? '' : String(selected)}
        onValueChange={(picked) => onChange(options[Number(picked)] ?? picked)}
      >
        {/* FieldRow can only wire the hint onto a DOM child; the Radix root above the trigger is not one. */}
        <SelectTrigger id={fieldId} aria-describedby={description ? `${fieldId}-hint` : undefined}>
          <SelectValue
            placeholder={
              hasDefault ? `Default: ${String(defaultOption)}` : (placeholder ?? 'Select…')
            }
          />
        </SelectTrigger>
        <SelectContent>
          {options.map((option, index) => (
            <SelectItem key={String(index)} value={String(index)}>
              {option === '' ? '(empty)' : String(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldRow>
  );
}

type Props = {
  inputs: Record<string, ManifestInput>;
  values: Record<string, unknown>;
  /** Namespaces field ids so two nodes with a same-named input never collide. */
  fieldIdPrefix: string;
  /** Node name backing `--list-options` lookups for listOptions fields. */
  blockType: string;
  /** Gates DynamicSelectField: its options script needs credentials resolved. */
  credentialsReady: boolean;
  onConfigPatch: (patch: Record<string, unknown>) => void;
};

export function SchemaFields({
  inputs,
  values,
  fieldIdPrefix,
  blockType,
  credentialsReady,
  onConfigPatch,
}: Props) {
  return (
    <>
      {Object.entries(inputs).map(([key, schema]) => {
        // Node-scoped: TemplatableField keys its authoring mode on this id, and two nodes
        // with a same-named input would otherwise share both the mode and the DOM id.
        const fieldId = `${fieldIdPrefix}-${key}`;
        const label = schema.label ?? key;
        const value = values[key];
        const fixedOptions = schema.options;
        return (
          <TemplatableField
            key={key}
            fieldId={fieldId}
            label={label}
            // An enum renders its own typed select; 'string' keeps TemplatableField on renderFixed.
            type={fixedOptions ? 'string' : (schema.type ?? 'string')}
            value={value}
            fallback={schema.default}
            placeholder={schema.placeholder}
            description={schema.description}
            required={schema.required}
            onChange={(v) => onConfigPatch({ [key]: v })}
            // Mounted only in fixed mode — it runs the node's `--list-options` script, which has
            // nothing to resolve against while the field holds a template.
            renderFixed={
              fixedOptions
                ? () => (
                    <StaticSelectField
                      fieldId={fieldId}
                      label={label}
                      options={fixedOptions}
                      selectedIndex={fixedOptions.findIndex((option) => option === value)}
                      defaultOption={fixedOptions.find((option) => option === schema.default)}
                      placeholder={schema.placeholder}
                      description={schema.description}
                      required={schema.required}
                      onChange={(v) => onConfigPatch({ [key]: v })}
                    />
                  )
                : schema.listOptions
                  ? () => (
                      <DynamicSelectField
                        fieldId={fieldId}
                        nodeName={blockType}
                        fieldName={key}
                        label={label}
                        value={typeof value === 'string' ? value : ''}
                        placeholder={schema.placeholder}
                        required={schema.required}
                        credentialsReady={credentialsReady}
                        onChange={(v: string) => onConfigPatch({ [key]: v })}
                      />
                    )
                  : undefined
            }
          />
        );
      })}
    </>
  );
}
