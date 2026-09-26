/**
 * Dynamic select field for custom node inputs with `listOptions: true`.
 * Runs the node script with `--list-options <fieldName>` (credentials injected server-side)
 * and renders a searchable combobox. Falls back to plain text input on error or missing credentials.
 */

import { Input } from '@benord-labs/frink-primitives';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../../components/ui/select';
import { trpc } from '../../../../../../lib/trpc';
import { FieldRow } from '../../shared';
import { parseDynamicSelectOptionsFromStdout } from './parse-dynamic-select-options';

type Props = {
  fieldId: string;
  nodeName: string;
  fieldName: string;
  label: string;
  value: string;
  placeholder?: string;
  required?: boolean;
  /** Whether all required credentials are configured — skip fetch if not */
  credentialsReady: boolean;
  onChange: (value: string) => void;
};

export function DynamicSelectField({
  fieldId,
  nodeName,
  fieldName,
  label,
  value,
  placeholder,
  required,
  credentialsReady,
  onChange,
}: Props): ReactElement {
  const inFlightKeyRef = useRef<string | null>(null);
  const [payload, setPayload] = useState<{ stdout: string } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [awaitingKey, setAwaitingKey] = useState<string | null>(null);

  const { mutate, reset } = trpc.customNodes.runNodeScript.useMutation({
    retry: false,
  });

  const mutateRef = useRef(mutate);
  const resetRef = useRef(reset);
  mutateRef.current = mutate;
  resetRef.current = reset;

  const activeKey = credentialsReady ? `${nodeName}\0${fieldName}` : '';
  const stillLoading = credentialsReady && awaitingKey !== null && awaitingKey === activeKey;

  useEffect(() => {
    if (!credentialsReady) {
      resetRef.current();
      setPayload(null);
      setLoadError(false);
      setAwaitingKey(null);
      inFlightKeyRef.current = null;
      return;
    }
    const key = `${nodeName}\0${fieldName}`;
    inFlightKeyRef.current = key;
    setLoadError(false);
    setPayload(null);
    setAwaitingKey(key);

    mutateRef.current(
      { nodeName, args: ['--list-options', fieldName] },
      {
        onSuccess: (data) => {
          if (inFlightKeyRef.current !== key) return;
          setPayload({ stdout: data.stdout });
        },
        onError: () => {
          if (inFlightKeyRef.current !== key) return;
          setLoadError(true);
          setPayload(null);
        },
        onSettled: () => {
          setAwaitingKey((curr) => (curr === key ? null : curr));
        },
      },
    );
  }, [credentialsReady, nodeName, fieldName]);

  const options = parseDynamicSelectOptionsFromStdout(payload?.stdout);

  const shouldFallback = !credentialsReady || loadError || (!stillLoading && options.length === 0);

  if (shouldFallback) {
    return (
      <FieldRow
        htmlFor={fieldId}
        label={label}
        error={required && value.trim() === '' ? `${label} is required.` : undefined}
        hint={!credentialsReady ? 'Configure credentials above to enable the picker.' : undefined}
      >
        <Input
          id={fieldId}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      </FieldRow>
    );
  }

  return (
    <FieldRow
      htmlFor={fieldId}
      label={label}
      error={required && value.trim() === '' ? `${label} is required.` : undefined}
    >
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={fieldId} disabled={stillLoading}>
          <SelectValue
            placeholder={stillLoading ? 'Loading options…' : (placeholder ?? 'Select…')}
          />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldRow>
  );
}
