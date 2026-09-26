/**
 * "Use in Flow": turns a plugin trigger into a ready-to-edit flow.
 *
 * Creates the flow row, seeds the editor's local draft with the trigger's
 * webhook_trigger → start_task → agent → end graph, then jumps to the Flow
 * editor. The draft is written at baselineVersion 0 because a freshly created
 * flow has no saved version, so FlowEditor hydrates the draft over its default
 * graph and the user lands on an unsaved, prefilled canvas — Save is still the
 * user's explicit act, exactly as if they had drawn the graph by hand.
 */
import { useSetAtom } from 'jotai';
import { toast } from 'sonner';
import type { PluginTrigger } from '../../../shared/integrations/plugins';
import { triggerRuleToFlow } from '../../../shared/lib/trigger-rule-to-flow';
import { activeOverlayAtom, flowsSelectedFlowIdAtom } from '../atoms';
import { saveFlowDraft } from '../flow-drafts';
import { trpc } from '../trpc';

type PluginFlowLaunch = {
  pluginName: string;
  trigger: PluginTrigger;
  /** Active connection the webhook trigger listens on — the graph binds its id. */
  connectionId: string;
};

export function usePluginFlowLaunch(): (input: PluginFlowLaunch) => void {
  const createFlow = trpc.flows.create.useMutation();
  const setSelectedFlowId = useSetAtom(flowsSelectedFlowIdAtom);
  const setActiveOverlay = useSetAtom(activeOverlayAtom);

  return ({ pluginName, trigger, connectionId }: PluginFlowLaunch) => {
    // A slow create must not mint a second flow from a second click.
    if (createFlow.isPending) return;
    const { name, graph } = triggerRuleToFlow({
      name: `${pluginName}: ${trigger.label}`,
      // biome-ignore lint/style/useNamingConvention: DB field name
      integration_id: connectionId,
      // biome-ignore lint/style/useNamingConvention: DB field name
      event_type: trigger.source.eventId,
    });
    createFlow.mutate(
      { name },
      {
        onSuccess: (flow) => {
          saveFlowDraft(flow.id, { graph, baselineVersion: 0, updatedAt: Date.now() });
          setSelectedFlowId(flow.id);
          setActiveOverlay('flows');
        },
        onError: () => toast.error(`Could not create a flow for ${pluginName}`),
      },
    );
  };
}
