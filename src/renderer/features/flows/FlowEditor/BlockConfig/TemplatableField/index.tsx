/**
 * A config field that can hold either a fixed typed value or a Flow template.
 *
 * A `number` widget rejects non-numeric text and a `Switch` has no text surface at all, so a typed
 * field has nowhere to put `{{previous.temperature}}`. Following n8n and Windmill, expression mode
 * REPLACES the typed widget rather than trying to make it accept text.
 *
 * Only offered for non-string fields: a plain text input already accepts templates inline, and a
 * string may legitimately mix literal text with placeholders.
 *
 * Typed fields store a single whole placeholder (`{{path}}`, nothing around it). Mixed
 * interpolation cannot survive coercion to a number or boolean, so it is rejected here at authoring
 * time instead of failing mid-run.
 */

import { Button, Input, Textarea } from '@benord-labs/frink-primitives';
import { Braces } from 'lucide-react';
import { type ReactElement, type ReactNode, useState } from 'react';
import { z } from 'zod';
import { TEMPLATE_VARIABLE_PATTERN } from '../../../../../../shared/lib/template-constants';
import { Switch } from '../../../../../components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../../components/ui/tooltip';
import { FieldRow } from '../shared';

const WHOLE_PLACEHOLDER_RE = new RegExp(`^${TEMPLATE_VARIABLE_PATTERN}$`);

/** True when the value is a string carrying at least one `{{...}}` placeholder. */
function holdsTemplate(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(TEMPLATE_VARIABLE_PATTERN).test(value);
}

/** A typed field's template must be exactly one placeholder — nothing before or after it. */
function wholePlaceholderError(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return 'Enter a variable, e.g. {{previous.count}}';
  if (!WHOLE_PLACEHOLDER_RE.test(trimmed)) {
    return 'Use exactly one variable and nothing else, e.g. {{previous.count}}';
  }
  return undefined;
}

/** FieldRow wires `aria-describedby` onto a lone child only; a control beside the toggle in a Row must name its hint itself. */
function hintId(fieldId: string, hint: string | undefined): string | undefined {
  return hint ? `${fieldId}-hint` : undefined;
}

type Props = {
  fieldId: string;
  label: string;
  /** Declared manifest type. Anything unrecognised behaves as `string`. */
  type: string;
  value: unknown;
  fallback?: unknown;
  placeholder?: string;
  /** What the field means, shown in full under the control. A placeholder truncates, so long text belongs here. */
  description?: string;
  required?: boolean;
  /** Replaces the fixed-mode control (e.g. a dynamic option picker that owns its own fetch). */
  renderFixed?: () => ReactElement;
  onChange: (value: unknown) => void;
};

/**
 * Which mode a field is in, plus the fixed value to put back if the user abandons a variable.
 *
 * Keyed by `fieldId` because the flow editor renders one field per input NAME with no key on the
 * node id: selecting another custom node with a same-named input reuses this instance, and the
 * mode must re-derive for the new field rather than carry over.
 */
type FieldMode = { id: string; expression: boolean; restore: unknown };

function initialMode(fieldId: string, value: unknown): FieldMode {
  const savedTemplate = holdsTemplate(value);
  // A field that MOUNTS holding a template has no fixed value behind it — abandoning clears.
  return { id: fieldId, expression: savedTemplate, restore: savedTemplate ? undefined : value };
}

export function TemplatableField(props: Props): ReactElement {
  const { fieldId, label, type, value, renderFixed, onChange } = props;

  // Mode is the user's authoring INTENT, not a function of the current value: deriving it would
  // eject the field the moment a half-typed `{{p` stopped looking like a template. It resets on
  // field identity, never on an edit.
  const [mode, setMode] = useState<FieldMode>(() => initialMode(fieldId, value));
  if (mode.id !== fieldId) setMode(initialMode(fieldId, value));

  const emit = onChange;
  // `||` so a template arriving from elsewhere still shows as one.
  const expression = (mode.id === fieldId && mode.expression) || holdsTemplate(value);

  // Text and raw-JSON inputs already accept templates inline, so neither needs a mode switch.
  const templatable = type === 'number' || type === 'boolean' || renderFixed !== undefined;

  if (expression && templatable) {
    const raw = typeof value === 'string' ? value : '';
    return (
      <FieldRow
        htmlFor={fieldId}
        label={label}
        error={wholePlaceholderError(raw)}
        hint="Resolved from the upstream step when the flow runs."
      >
        <Row>
          <Input
            id={fieldId}
            value={raw}
            placeholder="{{previous.count}}"
            onChange={(e) => emit(e.target.value)}
          />
          <ModeToggle
            active
            onClick={() => {
              setMode({ id: fieldId, expression: false, restore: mode.restore });
              // Always put the fixed value back. Leaving a half-typed `{{prev` in config would
              // render a clean fallback here and then fail coercion at dispatch with no clue why.
              if (value !== mode.restore) emit(mode.restore);
            }}
          />
        </Row>
      </FieldRow>
    );
  }

  const toggle = templatable ? (
    <ModeToggle
      active={false}
      // Switching mode alone must not destroy the fixed value — it is remembered as `restore` and
      // only replaced once the user actually types a variable over it.
      onClick={() => setMode({ id: fieldId, expression: true, restore: value })}
    />
  ) : null;

  return <FixedField {...props} onChange={emit} toggle={toggle} />;
}

type FixedProps = Props & { toggle: ReactNode };

/** Dispatches to the widget for the declared type; each one owns its own value reading. */
function FixedField(props: FixedProps): ReactElement {
  if (props.type === 'boolean') return <BooleanField {...props} />;
  if (props.type === 'number') return <NumberField {...props} />;
  if (props.type === 'json') return <JsonField {...props} />;
  if (props.renderFixed) return <CustomField {...props} />;
  return <TextField {...props} />;
}

function BooleanField({
  fieldId,
  label,
  value,
  fallback,
  description,
  onChange,
  toggle,
}: FixedProps) {
  return (
    <FieldRow htmlFor={fieldId} label={label} hint={description}>
      <Row>
        <Switch
          id={fieldId}
          checked={typeof value === 'boolean' ? value : fallback === true}
          aria-describedby={hintId(fieldId, description)}
          onCheckedChange={onChange}
        />
        {toggle}
      </Row>
    </FieldRow>
  );
}

function NumberField({
  fieldId,
  label,
  value,
  fallback,
  placeholder,
  description,
  onChange,
  toggle,
}: FixedProps) {
  return (
    <FieldRow htmlFor={fieldId} label={label} hint={description}>
      <Row>
        <Input
          id={fieldId}
          type="number"
          value={numberText(value, fallback)}
          placeholder={placeholder}
          aria-describedby={hintId(fieldId, description)}
          onChange={(e) => onChange(parsedNumber(e.target.value))}
        />
        {toggle}
      </Row>
    </FieldRow>
  );
}

/** A consumer-supplied control (e.g. a dynamic option picker) that renders its own label row. */
function CustomField({ renderFixed, toggle }: FixedProps) {
  return (
    <div className="flex min-w-0 items-end gap-1.5">
      <div className="min-w-0 flex-1">{renderFixed?.()}</div>
      {toggle}
    </div>
  );
}

function TextField({
  fieldId,
  label,
  value,
  fallback,
  placeholder,
  description,
  required,
  onChange,
}: FixedProps) {
  const text = typeof value === 'string' ? value : typeof fallback === 'string' ? fallback : '';
  return (
    <FieldRow
      htmlFor={fieldId}
      label={label}
      hint={description}
      error={required && text.trim() === '' ? `${label} is required.` : undefined}
    >
      <Input
        id={fieldId}
        value={text}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldRow>
  );
}

/**
 * A structured provider argument (object, array, composition) authored as raw JSON text; the
 * dispatcher parses it after templates render. An empty field means "omit the argument".
 */
function JsonField({
  fieldId,
  label,
  value,
  fallback,
  placeholder,
  description,
  required,
  onChange,
}: FixedProps) {
  // A value authored elsewhere as a structure (e.g. by an agent) shows as text and saves as text once edited.
  const text = z
    .string()
    .catch(value === undefined ? '' : JSON.stringify(value, null, 2))
    .parse(value);
  return (
    <FieldRow
      htmlFor={fieldId}
      label={`${label} (JSON)`}
      hint={description ?? placeholder}
      error={required && text.trim() === '' ? `${label} is required.` : undefined}
    >
      <Textarea
        id={fieldId}
        value={text}
        placeholder={fallback === undefined ? '{ }' : JSON.stringify(fallback, null, 2)}
        rows={4}
        className="font-mono text-xs"
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldRow>
  );
}

function numberText(value: unknown, fallback: unknown): string {
  if (typeof value === 'number') return String(value);
  return fallback === undefined || fallback === null ? '' : String(fallback);
}

/**
 * Number('') is 0 and passes Number.isFinite, so an emptied field would silently store a real zero.
 * Clearing means "unset", letting the manifest default apply.
 */
function parsedNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : undefined;
}

function Row({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex min-w-0 items-center gap-1.5">{children}</div>;
}

export function ModeToggle({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? 'secondary' : 'ghost'}
          size="icon"
          aria-pressed={active}
          aria-label={active ? 'Use a fixed value' : 'Use a variable'}
          onClick={onClick}
        >
          <Braces className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{active ? 'Use a fixed value' : 'Use a variable'}</TooltipContent>
    </Tooltip>
  );
}
