/* eslint-disable max-lines, max-lines-per-function */
/**
 * Webhook trigger: integration, event, filters (trigger-rule parity), webhook URL, connect CTA.
 */

import { Button, Input } from '@benord-labs/frink-primitives';
import { useSetAtom } from 'jotai';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  eventSupportsAssignee,
  getFilterFields,
  getProviderById,
} from '../../../../../../shared/integrations/selectors';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import {
  defaultWebhookAssignee,
  packWebhookTriggerConditions,
} from '../../../../../../shared/lib/webhook-trigger-condition-pack';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../components/ui/select';
import { Switch } from '../../../../../components/ui/switch';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
} from '../../../../../lib/atoms';
import {
  triggerDelivery,
  triggerDeliveryLine,
} from '../../../../../lib/plugins/triggers/delivery-state';
import { trpc } from '../../../../../lib/trpc';
import { STATE_TRANSITION_EVENTS } from '../../../../../lib/flows/webhook-trigger/constants';
import { parseConditions } from '../../../../../lib/flows/webhook-trigger/parse-conditions';
import type { AssigneeMode, ConditionFilter } from '../../../../../lib/flows/webhook-trigger/types';
import type { IntegrationProvider } from '../../../../integrations/types';
import { FieldRow } from '../shared';
import { AssigneeSection } from './AssigneeSection';
import { ConditionFiltersSection } from './ConditionFiltersSection';
import { EventTypeSelector } from './EventTypeSelector';
import { StateTransitionSection } from './StateTransitionSection';

type Props = {
  node: FlowNode;
  onPatchLabel: (patch: { label?: string }) => void;
  onPatchConfig: (config: Record<string, unknown>) => void;
};

function readString(obj: Record<string, unknown> | undefined, key: string): string {
  const v = obj?.[key];
  return typeof v === 'string' ? v : '';
}

function packConditions(o: {
  supportsStateTransition: boolean;
  supportsAssignee: boolean;
  fromStatus: string;
  toStatus: string;
  assigneeMode: AssigneeMode;
  filters: ConditionFilter[];
}): Record<string, unknown> {
  return packWebhookTriggerConditions({
    supportsStateTransition: o.supportsStateTransition,
    supportsAssignee: o.supportsAssignee,
    fromStatus: o.fromStatus,
    toStatus: o.toStatus,
    assigneeMode: o.assigneeMode,
    filters: o.filters.map((f) => ({ field: f.field, operator: f.operator, value: f.value })),
  });
}

export function WebhookTriggerConfig({ node, onPatchLabel, onPatchConfig }: Props): ReactElement {
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  const cfgRef = useRef(cfg);
  // Update ref synchronously to avoid stale data if pushFullConfig is called in the same render cycle
  cfgRef.current = cfg;
  const integrationId = readString(cfg, 'integrationId');
  const storedEventType = readString(cfg, 'eventType');
  const conditionsObj = useMemo(
    () =>
      cfg.conditions && typeof cfg.conditions === 'object' && !Array.isArray(cfg.conditions)
        ? (cfg.conditions as Record<string, unknown>)
        : {},
    [cfg.conditions],
  );

  const [eventType, setEventType] = useState(storedEventType);
  const [fromStatus, setFromStatus] = useState('');
  const [toStatus, setToStatus] = useState('');
  const [assigneeMode, setAssigneeMode] = useState<AssigneeMode>('me');
  const [filters, setFilters] = useState<ConditionFilter[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const setActiveSettingsTab = useSetAtom(agentsSettingsDialogActiveTabAtom);

  const handleManageConnections = useCallback(() => {
    setActiveSettingsTab('integrations');
    setSettingsOpen(true);
  }, [setActiveSettingsTab, setSettingsOpen]);

  const { data: integrations, isLoading: integrationsLoading } = trpc.integrations.list.useQuery();

  const selected = useMemo(
    () => integrations?.find((i) => i.id === integrationId),
    [integrations, integrationId],
  );

  const supportedProvider: IntegrationProvider | undefined = selected?.provider;
  const providerMeta = getProviderById(supportedProvider ?? '');
  // Every catalog row carries its event registry + condition filters; a row with one event
  // (the generic webhook's `received`) needs no picker, so that event is stated instead.
  const isSupported = providerMeta !== undefined && providerMeta.events.length > 1;
  const singleEvent = providerMeta?.events.length === 1 ? providerMeta.events[0] : undefined;

  const { data: eventTypes } = trpc.triggerRules.getEventTypes.useQuery(
    { provider: supportedProvider ?? '' },
    { enabled: Boolean(selected && isSupported) },
  );

  useEffect(() => {
    setEventType(storedEventType);
    const parsed = parseConditions(conditionsObj, storedEventType, supportedProvider ?? '');
    setAssigneeMode(parsed.assigneeMode);
    setFromStatus(parsed.fromStatus);
    setToStatus(parsed.toStatus);
    setFilters(parsed.filters);
    setShowFilters(parsed.filters.length > 0);
  }, [node.id, storedEventType, conditionsObj, supportedProvider]);

  const supportsStateTransition = STATE_TRANSITION_EVENTS.includes(eventType);
  const supportsAssignee = eventSupportsAssignee(supportedProvider ?? '', eventType);
  const availableFilterFields: Array<{ id: string; label: string }> = useMemo(() => {
    if (!supportedProvider) return [];
    return getFilterFields(supportedProvider, eventType).map((f) => ({ id: f.id, label: f.label }));
  }, [supportedProvider, eventType]);
  const { data: webhookEndpoints } = trpc.integrations.listWebhookEndpoints.useQuery(
    { integrationId },
    { enabled: Boolean(integrationId) },
  );

  // The same delivery state the plugin page shows, in one line: an address to paste, a
  // subscription Frink made, or Frink's own app carrying it.
  const deliveryLine = useMemo(() => {
    const endpoints = webhookEndpoints?.success ? webhookEndpoints.endpoints : [];
    return triggerDeliveryLine(
      providerMeta,
      triggerDelivery({ provider: providerMeta, endpoints }),
    );
  }, [providerMeta, webhookEndpoints]);

  const pushFullConfig = useCallback(
    (patch: Record<string, unknown>) => {
      onPatchConfig({
        ...cfgRef.current,
        ...patch,
      });
    },
    [onPatchConfig],
  );

  const commitFiltersAndPush = useCallback(
    (newFilters: ConditionFilter[]) => {
      setFilters(newFilters);
      pushFullConfig({
        integrationId: integrationId || undefined,
        eventType: eventType || undefined,
        conditions: packConditions({
          supportsStateTransition,
          supportsAssignee,
          fromStatus,
          toStatus,
          assigneeMode,
          filters: newFilters,
        }),
      });
    },
    [
      integrationId,
      eventType,
      pushFullConfig,
      supportsStateTransition,
      supportsAssignee,
      fromStatus,
      toStatus,
      assigneeMode,
    ],
  );

  const onIntegrationSelect = (id: string) => {
    // A single-event provider (the generic webhook's `received`) is persisted eagerly so
    // the trigger is fully configured without an event dropdown.
    const nextProvider = integrations?.find((i) => i.id === id)?.provider;
    const nextEvents = getProviderById(nextProvider ?? '')?.events ?? [];
    const nextEventType = nextEvents.length === 1 ? nextEvents[0]?.id : undefined;
    pushFullConfig({
      integrationId: id,
      eventType: nextEventType,
      conditions: {},
    });
    setEventType(nextEventType ?? '');
    setFromStatus('');
    setToStatus('');
    setAssigneeMode('me');
    setFilters([]);
    setShowFilters(false);
  };

  const onEventTypeChange = (value: string) => {
    setEventType(value);
    setFromStatus('');
    setToStatus('');
    const nextAssignee = defaultWebhookAssignee(value);
    setAssigneeMode(nextAssignee);
    const nextSupportsState = STATE_TRANSITION_EVENTS.includes(value);
    const nextSupportsAssignee = eventSupportsAssignee(supportedProvider ?? '', value);
    pushFullConfig({
      integrationId: integrationId || undefined,
      eventType: value,
      conditions: packConditions({
        supportsStateTransition: nextSupportsState,
        supportsAssignee: nextSupportsAssignee,
        fromStatus: '',
        toStatus: '',
        assigneeMode: nextAssignee,
        filters: [],
      }),
    });
  };

  const addFilter = useCallback(() => {
    const nf: ConditionFilter = {
      id: crypto.randomUUID(),
      field: availableFilterFields[0]?.id || '',
      operator: 'equals',
      value: '',
    };
    commitFiltersAndPush([...filters, nf]);
  }, [availableFilterFields, filters, commitFiltersAndPush]);

  const updateFilter = useCallback(
    (id: string, updates: Partial<ConditionFilter>) => {
      commitFiltersAndPush(filters.map((f) => (f.id === id ? { ...f, ...updates } : f)));
    },
    [filters, commitFiltersAndPush],
  );

  const removeFilter = useCallback(
    (id: string) => {
      commitFiltersAndPush(filters.filter((f) => f.id !== id));
    },
    [filters, commitFiltersAndPush],
  );

  return (
    <div className="space-y-4">
      <FieldRow htmlFor="flow-webhook-label" label="Display name">
        <Input
          id="flow-webhook-label"
          value={node.label ?? ''}
          onChange={(e) => onPatchLabel({ label: e.target.value })}
          placeholder="Webhook trigger"
        />
      </FieldRow>

      {!integrations?.length && !integrationsLoading ? (
        <div className="rounded-md border border-dashed border-border/80 p-3 space-y-2">
          <p className="text-xs text-muted-foreground">No integrations connected yet.</p>
          <Button type="button" size="sm" variant="secondary" onClick={handleManageConnections}>
            Connect an integration
          </Button>
        </div>
      ) : (
        <FieldRow htmlFor="flow-webhook-integration" label="Integration">
          <Select
            value={integrationId || undefined}
            onValueChange={onIntegrationSelect}
            disabled={integrationsLoading}
          >
            <SelectTrigger id="flow-webhook-integration">
              <SelectValue placeholder="Select integration…" />
            </SelectTrigger>
            <SelectContent>
              {integrations?.map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {getProviderById(i.provider)?.display_name ?? 'Integration'}
                  {i.accountName ? ` — ${i.accountName}` : ` — ${i.accountIdentifier}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={handleManageConnections}
          >
            Add or manage connections
          </Button>
        </FieldRow>
      )}

      {selected && isSupported ? (
        <>
          <EventTypeSelector
            eventType={eventType}
            eventTypes={eventTypes}
            onEventTypeChange={onEventTypeChange}
          />

          {supportsStateTransition ? (
            <StateTransitionSection
              fromStatus={fromStatus}
              toStatus={toStatus}
              onFromStatusChange={(v) => {
                setFromStatus(v);
                pushFullConfig({
                  integrationId: integrationId || undefined,
                  eventType: eventType || undefined,
                  conditions: packConditions({
                    supportsStateTransition,
                    supportsAssignee,
                    fromStatus: v,
                    toStatus,
                    assigneeMode,
                    filters,
                  }),
                });
              }}
              onToStatusChange={(v) => {
                setToStatus(v);
                pushFullConfig({
                  integrationId: integrationId || undefined,
                  eventType: eventType || undefined,
                  conditions: packConditions({
                    supportsStateTransition,
                    supportsAssignee,
                    fromStatus,
                    toStatus: v,
                    assigneeMode,
                    filters,
                  }),
                });
              }}
            />
          ) : null}

          {supportsAssignee ? (
            <AssigneeSection
              assigneeMode={assigneeMode}
              supportsMe={Boolean(selected?.externalUserId)}
              onAssigneeModeChange={(m) => {
                setAssigneeMode(m);
                pushFullConfig({
                  integrationId: integrationId || undefined,
                  eventType: eventType || undefined,
                  conditions: packConditions({
                    supportsStateTransition,
                    supportsAssignee,
                    fromStatus,
                    toStatus,
                    assigneeMode: m,
                    filters,
                  }),
                });
              }}
              accountIdentifier={selected.accountIdentifier}
            />
          ) : null}

          <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2">
            <span className="text-xs font-medium">Advanced filters</span>
            <Switch checked={showFilters} onCheckedChange={setShowFilters} />
          </div>

          {showFilters ? (
            <ConditionFiltersSection
              filters={filters}
              showFilters={showFilters}
              availableFilterFields={availableFilterFields}
              onShowFiltersToggle={() => setShowFilters((s) => !s)}
              onAddFilter={addFilter}
              onUpdateFilter={updateFilter}
              onRemoveFilter={removeFilter}
            />
          ) : null}
        </>
      ) : selected && singleEvent ? (
        <div className="rounded-md border border-border/60 px-3 py-2">
          <p className="text-xs font-medium">Event</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {singleEvent.description ?? singleEvent.label}
          </p>
        </div>
      ) : selected ? (
        <p className="text-xs text-muted-foreground">
          Event selection for this provider is not available in the flow editor yet.
        </p>
      ) : null}

      {integrationId ? (
        <FieldRow label="Delivery">
          <p className="break-all text-xs text-muted-foreground">{deliveryLine}</p>
        </FieldRow>
      ) : null}
    </div>
  );
}
