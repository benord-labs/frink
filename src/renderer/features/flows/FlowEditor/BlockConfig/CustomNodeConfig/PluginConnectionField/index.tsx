/**
 * Account picker for plugin-spawned nodes: multi-account = one node set per
 * plugin with the connection chosen here (decision integration-connector-
 * lifecycle). Empty value = "the single active account", resolved at dispatch.
 */
import { trpc } from '../../../../../../lib/trpc';
import { FieldRow } from '../../shared';

type Props = {
  fieldId: string;
  provider: string;
  value: string;
  onChange: (connectionId: string) => void;
};

export function PluginConnectionField({ fieldId, provider, value, onChange }: Props) {
  const { data: integrations } = trpc.integrations.list.useQuery();
  const accounts = (integrations ?? []).filter((i) => i.provider === provider);
  if (accounts.length <= 1 && !value) return null;
  return (
    <FieldRow htmlFor={fieldId} label="Account" hint="Which connected account this node acts as.">
      <select
        id={fieldId}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Single active account</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.accountName || a.accountIdentifier || a.id}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}
