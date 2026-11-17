import { describe, expect, it } from 'vitest';
import {
  bindingConfigSchemaFor,
  isBindingConfigTriggerType,
  postTaskBindingConfigSchema,
  scheduleBindingConfigSchema,
} from './flow-trigger-binding-config';

describe('postTaskBindingConfigSchema', () => {
  it.each([
    [{ triggerStates: ['done', 'completed'] }],
    [{ triggerStates: ['all'] }],
    [{ triggerStates: ['failed'], filterBySource: ['manual', 'shortcut'] }],
    [{ triggerStates: ['plan_ready'], filterBySource: [] }],
  ])('accepts %j', (config) => {
    expect(postTaskBindingConfigSchema.parse(config)).toEqual(config);
  });

  it.each([
    [{}],
    [{ triggerStates: [] }],
    [{ triggerStates: 'done' }],
    [{ triggerStates: ['bogus'] }],
    [{ triggerStates: ['done'], filterBySource: 'manual' }],
    [{ triggerStates: ['done'], cronExpression: '* * * * *' }],
  ])('rejects %j', (config) => {
    expect(postTaskBindingConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe('scheduleBindingConfigSchema', () => {
  it('accepts an empty config', () => {
    expect(scheduleBindingConfigSchema.parse({})).toEqual({});
  });

  it.each([[{ wrong: 'shape' }], [{ cronExpression: '* * * * *', timezone: 'UTC' }]])(
    'rejects %j, since schedule settings live on the flow-graph node',
    (config) => {
      expect(scheduleBindingConfigSchema.safeParse(config).success).toBe(false);
    },
  );
});

describe('bindingConfigSchemaFor', () => {
  it('returns the schema that belongs to each trigger type', () => {
    expect(bindingConfigSchemaFor('post_task_trigger')).toBe(postTaskBindingConfigSchema);
    expect(bindingConfigSchemaFor('schedule_trigger')).toBe(scheduleBindingConfigSchema);
  });

  it('recognises only the trigger types that have a binding row', () => {
    expect(isBindingConfigTriggerType('post_task_trigger')).toBe(true);
    expect(isBindingConfigTriggerType('webhook_trigger')).toBe(false);
    expect(isBindingConfigTriggerType('toString')).toBe(false);
  });
});
