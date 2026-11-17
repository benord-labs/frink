import type { SDKModel } from '@cursor/sdk';
import {
  EFFORT_LABEL,
  isEffortKey,
  modelRowFor,
} from '../../../../shared/lib/model-picker-label/groups';
import { type AgentModel, rememberAgentModels } from '../agent-models';
import type { CursorModel } from './cursor-events';

const AUTO = 'default';
// The parameters Cursor's models name their effort by; other parameters keep Cursor's default.
const EFFORT_PARAMS = new Set(['effort', 'reasoning_effort', 'reasoning']);

// Default-variant lookup adapted from T3 Code (MIT), packages/provider-cursor/src/server/status.ts.
function defaultValue(model: SDKModel, paramId: string): string | undefined {
  return model.variants
    ?.find((variant) => variant.isDefault)
    ?.params.find((param) => param.id === paramId)?.value;
}

/** One row per model, or per effort it offers, so a saved effort outlives a new default. */
function modelRows(model: SDKModel): AgentModel[] {
  const { id, displayName: name } = model;
  const param = model.parameters?.find((p) => EFFORT_PARAMS.has(p.id));
  const efforts = (param?.values ?? []).map((entry) => entry.value).filter(isEffortKey);
  if (!param || efforts.length === 0) return [{ id, name }];
  const fallback = defaultValue(model, param.id);
  return efforts.map((effort) => ({
    id: `${id}/${effort}`,
    name,
    familyId: id,
    effort,
    detail: EFFORT_LABEL[effort],
    params: [{ id: param.id, value: effort }],
    ...(effort === fallback && { effortDefault: true }),
  }));
}

/** Cursor's models as picker rows, Auto first. */
export function cursorModelRows(models: readonly SDKModel[]): AgentModel[] {
  const auto = models.filter((model) => model.id === AUTO);
  return [...auto, ...models.filter((model) => model.id !== AUTO)].flatMap(modelRows);
}

/** Keeps the models Cursor just listed, for the picker, Settings and the next turn. */
export function saveCursorModels(models: readonly SDKModel[]): void {
  rememberAgentModels('cursor', cursorModelRows(models));
}

type ModelChoice = { model?: CursorModel; refusal?: string };

/** The model a turn sends for a picker id, from Cursor's saved list; a refusal once it is gone. */
export function cursorModelFor(
  rows: readonly AgentModel[],
  picked: string | undefined,
): ModelChoice {
  if (!picked || rows.length === 0) return {};
  const { model, offered, row } = modelRowFor(rows, picked);
  if (!offered) return { refusal: `Cursor no longer offers ${model}. Pick another model.` };
  const params = row?.params;
  return { model: { id: offered.familyId ?? offered.id, ...(params && { params }) } };
}
