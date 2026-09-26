/**
 * Config panel for a custom node.
 *
 * Two shapes behind one block type. A USER-AUTHORED node gets the developer
 * surface (manifest, entrypoint, folder, credentials). A Frink plugin step is
 * identified by its catalog action and shows only what a person configures —
 * account and inputs. Its manifest is machine-owned plumbing and stays hidden
 * (decision `frink-integration-plugin`, 2026-08-18 Target).
 */

import { Input } from '@benord-labs/frink-primitives';
import { type ComponentProps, type ReactElement, useMemo } from 'react';
import { z } from 'zod';
import {
  findPluginActionByNodeName,
  isGenericCallToolAction,
  reservedPluginIdForNodeName,
} from '../../../../../../shared/integrations/plugin-nodes';
import { getPluginDefinition } from '../../../../../../shared/integrations/plugins';
import { BRAND_TILE_RIM_STYLE, ProviderIcon } from '../../../../../components/ProviderIcon';
import {
  findMissingRequiredCustomNodeInputs,
  type JsonValue,
  parseManifestInputDeclarations,
} from '../../../../../../shared/lib/flows/custom-node-required-inputs';
import { trpc } from '../../../../../lib/trpc';
import { AvailableVariables } from '../AvailableVariables';
import { NodeProjectField } from '../NodeProjectField';
import { type ManifestInput, SchemaFields } from '../SchemaFields';
import { cfg, FieldRow, type ProjectNodeConfigProps } from '../shared';
import { CredentialField } from './CredentialField';
import { CustomNodeDeveloperDetails } from './CustomNodeDeveloperDetails';
import { CallToolStep } from './CallToolStep';
import { PluginConnectionField } from './PluginConnectionField';

type ManifestCredential = {
  required?: boolean;
  label?: string;
  helpUrl?: string;
};

type Props = ProjectNodeConfigProps;

/** Brand plate + catalog copy — the plugin equivalent of the developer "Node details" block. */
function PluginStepIdentity({
  pluginId,
  description,
}: {
  pluginId: string;
  description: string | undefined;
}): ReactElement {
  return (
    <div className="flex items-start gap-3">
      <span
        className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg"
        style={BRAND_TILE_RIM_STYLE}
      >
        <ProviderIcon providerId={pluginId} appearance="tile" className="size-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-foreground">
          {getPluginDefinition(pluginId)?.name ?? pluginId}
        </span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** The shape CredentialField reads; the tRPC status rows satisfy it. */
type CredentialStatus = NonNullable<ComponentProps<typeof CredentialField>['status']>;

/** Labels of required credentials the user has not configured yet. */
function missingRequiredCredentials(
  credentials: Record<string, ManifestCredential>,
  statuses: CredentialStatus[] | undefined,
): string[] {
  return Object.entries(credentials)
    .filter(([key, cred]) => {
      if (cred.required === false) return false;
      return !statuses?.find((s) => s.key === key)?.configured;
    })
    .map(([, cred]) => cred.label ?? 'a required credential');
}

function CredentialsSection({
  nodeName,
  credentials,
  statuses,
  missing,
  onSaved,
}: {
  nodeName: string;
  credentials: Record<string, ManifestCredential>;
  statuses: CredentialStatus[] | undefined;
  missing: string[];
  onSaved: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Credentials
      </p>

      {missing.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          This node requires credentials to run: {missing.join(', ')}.
        </div>
      )}

      {Object.entries(credentials).map(([key, cred]) => (
        <CredentialField
          key={key}
          nodeName={nodeName}
          credKey={key}
          meta={cred}
          status={statuses?.find((s) => s.key === key)}
          onSaved={onSaved}
        />
      ))}
    </div>
  );
}

/** The same inputs with every `json` declaration shown as text; the original object when none is. */
function asTextInputs(inputs: Record<string, ManifestInput>): Record<string, ManifestInput> {
  if (!Object.values(inputs).some((input) => input.type === 'json')) return inputs;
  return Object.fromEntries(
    Object.entries(inputs).map(([key, input]) => [
      key,
      input.type === 'json' ? { ...input, type: 'string' } : input,
    ]),
  );
}

export function CustomNodeConfig({
  node,
  flowSettings,
  onPatchLabel,
  onConfigPatch,
  onOpenFlowSettings,
  ...upstreamContext
}: Props): ReactElement {
  const c = cfg(node);
  const blockType = node.blockType;
  const projectId = typeof c.projectId === 'string' ? c.projectId : '';

  // Name-derived and synchronous, so the panel picks its shape on first render.
  // Matches the dispatcher's own predicate — the UI must not present a step as a
  // plugin action that dispatch would refuse to route. Plugin nodes are derived
  // from the catalog itself, so none can be plugin-owned yet catalog-unresolvable.
  const pluginStep = findPluginActionByNodeName(blockType);
  const pluginNamespace = reservedPluginIdForNodeName(blockType);

  const { data: customNodes } = trpc.customNodes.list.useQuery(undefined, {
    staleTime: 30_000,
  });

  const { data: localDiscovery } = trpc.customNodes.discoverLocal.useQuery(undefined, {
    staleTime: 30_000,
  });

  const localManifest = localDiscovery?.valid?.find((m) => m.name === blockType);
  const credentials = (localManifest?.credentials ?? {}) as Record<string, ManifestCredential>;
  const hasCredentials = Object.keys(credentials).length > 0;

  const { data: credentialStatuses, refetch: refetchCredentials } =
    trpc.customNodes.getCredentialStatus.useQuery(
      { nodeName: blockType },
      { enabled: hasCredentials, staleTime: 5_000 },
    );

  const nodeType = customNodes?.find((n) => n.name === blockType);
  // SAFETY: the manifest inputs block arrives as plain JSON over tRPC; SchemaFields reads each field defensively.
  const declared = (nodeType?.inputs ?? {}) as Record<string, ManifestInput>;
  // A script node receives `json` as plain text (its runtime knows string, number, boolean); only a
  // plugin node's dispatcher parses it, so only a plugin node gets the JSON editor.
  const inputs = pluginStep ? declared : asTextInputs(declared);
  const genericStep = pluginStep && isGenericCallToolAction(pluginStep.action) ? pluginStep : null;
  const connectionId = z.string().catch('').parse(c.connectionId);
  const unsupportedFields = nodeType?.unsupportedFields ?? [];

  const missingRequired = missingRequiredCredentials(credentials, credentialStatuses);

  // SAFETY: the manifest arrives as plain JSON over tRPC and is re-parsed before any field is read.
  // Memoized: config fields re-render this panel per keystroke; the manifest rarely changes.
  const declarations = useMemo(() => parseManifestInputDeclarations(inputs as JsonValue), [inputs]);
  // SAFETY: the node config comes out of graph storage, which holds only plain JSON.
  const missingRequiredInputs = findMissingRequiredCustomNodeInputs(
    declarations,
    c as Record<string, JsonValue>,
  );

  return (
    <div className="flex flex-col gap-3">
      <FieldRow
        htmlFor="flow-custom-node-label"
        label="Display name"
        hint="Shown in the step list."
      >
        <Input
          id="flow-custom-node-label"
          value={node.label ?? ''}
          onChange={(e) => onPatchLabel({ label: e.target.value })}
          placeholder={pluginStep?.action.label ?? node.blockType}
        />
      </FieldRow>

      {pluginStep ? (
        <PluginStepIdentity
          pluginId={pluginStep.pluginId}
          description={pluginStep.action.description}
        />
      ) : (
        <CustomNodeDeveloperDetails
          blockType={blockType}
          localManifest={localManifest}
          nodeType={nodeType}
        />
      )}

      {/* Plugin dispatch resolves the catalog action and never reads projectId. */}
      {pluginStep ? null : (
        <NodeProjectField
          key={node.id}
          allowTemplate={false}
          projectId={projectId}
          flowDefaultProjectId={flowSettings?.defaultProjectId}
          onProjectIdChange={(id: string) => onConfigPatch({ projectId: id })}
          onOpenFlowSettings={onOpenFlowSettings}
        />
      )}

      {hasCredentials && (
        <CredentialsSection
          nodeName={blockType}
          credentials={credentials}
          statuses={credentialStatuses}
          missing={missingRequired}
          onSaved={() => void refetchCredentials()}
        />
      )}

      {pluginStep ? (
        <PluginConnectionField
          fieldId={`custom-node-${node.id}-connection`}
          provider={pluginStep.pluginId}
          value={connectionId}
          onChange={(connectionId) => onConfigPatch({ connectionId })}
        />
      ) : null}

      {genericStep ? (
        <CallToolStep node={node} pluginId={genericStep.pluginId} onConfigPatch={onConfigPatch} />
      ) : null}

      {!genericStep && Object.keys(inputs).length > 0 && (
        <div className="flex flex-col gap-3">
          {hasCredentials && (
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Inputs
            </p>
          )}

          {missingRequiredInputs.length > 0 && (
            <div className="text-warning rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs">
              This node needs a value for: {missingRequiredInputs.join(', ')}.
            </div>
          )}

          <SchemaFields
            inputs={inputs}
            values={c}
            fieldIdPrefix={`custom-node-${node.id}`}
            blockType={blockType}
            credentialsReady={missingRequired.length === 0}
            onConfigPatch={onConfigPatch}
          />
        </div>
      )}

      {unsupportedFields.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Not editable here: {unsupportedFields.join(', ')}.
        </p>
      )}

      {!nodeType && (
        <p className="text-sm text-muted-foreground">
          {/* Prefix match, not the exact one: a node whose action was retired is no
              longer catalog-resolvable, but it is still plugin-namespaced and must
              not be told to sync manifests it does not own. */}
          {pluginNamespace
            ? `Connect ${getPluginDefinition(pluginNamespace)?.name ?? pluginNamespace} in Settings → Plugins to use this step.`
            : `Custom node "${blockType}" not found in cloud. Sync your nodes to load inputs schema.`}
        </p>
      )}
      <AvailableVariables {...upstreamContext} />
    </div>
  );
}
