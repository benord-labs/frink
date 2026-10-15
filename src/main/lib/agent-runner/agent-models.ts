import log from 'electron-log';
import type { PickerGroupFields } from '../../../shared/lib/model-picker-label/groups';
import { getDatabase } from '../db';
import { getPreference, setPreference } from '../db/repos/composer-settings';

/** A picker row an installed agent reported: a model, or one effort of a model. */
export type AgentModel = PickerGroupFields & {
  detail?: string;
  /** The model parameters a turn sends for this row, for agents that take them. */
  params?: { id: string; value: string }[];
};

const key = (agentId: string) => `agentModels.${agentId}`;

/** Keeps the models an agent just reported, so its picker has them after a restart. */
export function rememberAgentModels(agentId: string, models: AgentModel[]): void {
  if (models.length === 0) return;
  try {
    setPreference(getDatabase(), key(agentId), models);
  } catch (error) {
    // The turn still checks the chosen model against the list it was just given.
    log.warn(`[Agent models] Could not save ${agentId}'s models`, error);
  }
}

/** The models the agent last reported on this computer; none before its first session. */
export function rememberedAgentModels(agentId: string): AgentModel[] {
  return getPreference<AgentModel[]>(getDatabase(), key(agentId)) ?? [];
}
