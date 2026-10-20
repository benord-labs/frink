import { describe, expect, it } from 'vitest';
import { PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT } from '../../types/plan';
import { TRIGGER_BUBBLE_MARKER } from '../trigger-bubble-marker';
import { buildHiddenWakeMessage } from './hidden-wake-marker';
import {
  dispatchMetadataSchema,
  FLOW_DISPATCH_SOURCE,
  isMachineText,
  isPersonAuthoredMessage,
} from './person-authored';

describe('isMachineText', () => {
  it('is true for a wake, a triggered task’s opening and a plan approval', () => {
    expect(isMachineText(buildHiddenWakeMessage('Continue'))).toBe(true);
    expect(isMachineText(`${TRIGGER_BUBBLE_MARKER}{"uiData":{}}-->\n\nDo it`)).toBe(true);
    expect(isMachineText(PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT)).toBe(true);
  });

  it('is false for typed text, including a dragged-in task', () => {
    expect(isMachineText('look at @[file:local:a.ts]')).toBe(false);
    expect(isMachineText('<!--TASK_BUBBLE:{}-->do it')).toBe(false);
  });
});

describe('dispatchMetadataSchema', () => {
  it('rejects metadata of another shape, so the caller can treat it as not a person', () => {
    expect(dispatchMetadataSchema.safeParse(undefined).success).toBe(true);
    expect(dispatchMetadataSchema.safeParse({ source: 'flow-dispatch', other: 1 }).success).toBe(
      true,
    );
    expect(dispatchMetadataSchema.safeParse({ dispatchTaskId: 7 }).success).toBe(false);
    expect(dispatchMetadataSchema.safeParse(null).success).toBe(false);
  });
});

describe('isPersonAuthoredMessage', () => {
  const typed = { role: 'user', text: 'hello', metadata: undefined };

  it('is true for a user message with no dispatch metadata', () => {
    expect(isPersonAuthoredMessage(typed)).toBe(true);
    expect(isPersonAuthoredMessage({ ...typed, metadata: {} })).toBe(true);
  });

  it('is false for a Flow or task dispatch, Frink’s own text and any other role', () => {
    expect(isPersonAuthoredMessage({ ...typed, metadata: { source: FLOW_DISPATCH_SOURCE } })).toBe(
      false,
    );
    expect(isPersonAuthoredMessage({ ...typed, metadata: { dispatchTaskId: 't1' } })).toBe(false);
    expect(isPersonAuthoredMessage({ ...typed, text: buildHiddenWakeMessage('Go') })).toBe(false);
    expect(isPersonAuthoredMessage({ ...typed, role: 'assistant' })).toBe(false);
  });
});
