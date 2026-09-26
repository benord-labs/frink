import type { FlowSettings } from '../../../../../shared/types/flow';

/** Shallow-merge a partial settings update onto current flow settings. */
export function patch(
  current: FlowSettings | undefined,
  update: Partial<FlowSettings>,
): FlowSettings {
  return { ...current, ...update };
}
