import { describe, expect, it } from 'vitest';
import type { NodeVariables } from '../../../../../../shared/lib/validate-flow-templates';
import {
  classifyTemplatePath,
  extractTemplateRanges,
  warningMessageForPlaceholder,
} from './classify-template-placeholder';

function makeVars(partial: Partial<NodeVariables>): NodeVariables {
  return {
    previous: partial.previous ?? [],
    trigger: partial.trigger ?? [],
    loop: partial.loop ?? null,
    flow: partial.flow ?? null,
    notes: partial.notes ?? [],
    allowsArbitraryTriggerKeys: partial.allowsArbitraryTriggerKeys,
  };
}

describe('extractTemplateRanges', () => {
  it('returns trimmed path and correct indices for multiple placeholders', () => {
    const text = 'a {{previous.exitCode}} b {{trigger.event}}';
    const ranges = extractTemplateRanges(text);
    expect(ranges).toHaveLength(2);
    const first = ranges[0];
    const second = ranges[1];
    if (!first || !second) throw new Error('expected two ranges');
    expect(first).toMatchObject({
      start: 2,
      path: 'previous.exitCode',
      raw: '{{previous.exitCode}}',
    });
    expect(first.end).toBe(2 + '{{previous.exitCode}}'.length);
    expect(second).toMatchObject({
      path: 'trigger.event',
      raw: '{{trigger.event}}',
    });
  });

  it('trims internal whitespace inside placeholder body', () => {
    const ranges = extractTemplateRanges('x{{  previous.exitCode  }}y');
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({
      path: 'previous.exitCode',
      raw: '{{  previous.exitCode  }}',
    });
  });

  it('skips empty placeholders and does not match unclosed braces', () => {
    expect(extractTemplateRanges('{{}}')).toHaveLength(0);
    expect(extractTemplateRanges('{{ incomplete')).toHaveLength(0);
    expect(extractTemplateRanges('plain')).toHaveLength(0);
  });
});

describe('classifyTemplatePath', () => {
  const dynamicNotes = [
    'These dynamic fields can be referenced as {{previous.<fieldName>}} even if not listed above.',
  ];

  it('returns undeclared for unknown root (not trigger/previous/loop)', () => {
    const vars = makeVars({
      previous: [{ key: 'exitCode', type: 'number', description: '', guaranteed: true }],
    });
    expect(classifyTemplatePath('env.HOME', vars)).toBe('undeclared');
  });

  it('previous: valid when first segment matches declared key', () => {
    const vars = makeVars({
      previous: [{ key: 'exitCode', type: 'number', description: '', guaranteed: true }],
    });
    expect(classifyTemplatePath('previous.exitCode', vars)).toBe('valid');
  });

  it('previous: dynamic tone when key missing but predecessor has dynamic JSON note', () => {
    const vars = makeVars({
      previous: [{ key: 'exitCode', type: 'number', description: '', guaranteed: true }],
      notes: dynamicNotes,
    });
    expect(classifyTemplatePath('previous.prCount', vars)).toBe('dynamic');
  });

  it('previous: undeclared when key missing and no dynamic note (static predecessor schema)', () => {
    const vars = makeVars({
      previous: [{ key: 'chatId', type: 'string', description: '', guaranteed: true }],
      notes: [],
    });
    expect(classifyTemplatePath('previous.exitCode', vars)).toBe('undeclared');
  });

  it('previous: loading gate — dynamic when vars missing, custom predecessor, manifest still loading', () => {
    expect(
      classifyTemplatePath('previous.foo', null, {
        predecessorIsCustomNode: true,
        customNodesLoading: true,
      }),
    ).toBe('dynamic');
  });

  it('previous: custom predecessor + loading stays dynamic when previous list empty (manifest not merged)', () => {
    const vars = makeVars({
      previous: [],
      notes: [],
    });
    expect(
      classifyTemplatePath('previous.foo', vars, {
        predecessorIsCustomNode: true,
        customNodesLoading: true,
      }),
    ).toBe('dynamic');
  });

  it('previous: after manifest load, unknown field is undeclared when not in schema', () => {
    const vars = makeVars({
      previous: [{ key: 'bar', type: 'string', description: '', guaranteed: true }],
      notes: [],
    });
    expect(
      classifyTemplatePath('previous.foo', vars, {
        predecessorIsCustomNode: true,
        customNodesLoading: false,
      }),
    ).toBe('undeclared');
  });

  it('trigger: valid vs undeclared from declared trigger keys', () => {
    const vars = makeVars({
      trigger: [{ key: 'event', type: 'string', description: 'Webhook event' }],
    });
    expect(classifyTemplatePath('trigger.event', vars)).toBe('valid');
    expect(classifyTemplatePath('trigger.unknown', vars)).toBe('undeclared');
  });

  it('trigger: undeclared key is dynamic (not red) when allowsArbitraryTriggerKeys=true', () => {
    const vars = makeVars({
      trigger: [{ key: 'label', type: 'string', description: 'Label' }],
      allowsArbitraryTriggerKeys: true,
    });
    // Declared key stays valid (green)
    expect(classifyTemplatePath('trigger.label', vars)).toBe('valid');
    // Undeclared key is dynamic (yellow) not undeclared (red)
    expect(classifyTemplatePath('trigger.ticketId', vars)).toBe('dynamic');
    expect(classifyTemplatePath('trigger.workstreamId', vars)).toBe('dynamic');
  });

  it('trigger: undeclared key stays red on flows without allowsArbitraryTriggerKeys', () => {
    const vars = makeVars({
      trigger: [{ key: 'event', type: 'string', description: 'Event' }],
      allowsArbitraryTriggerKeys: undefined,
    });
    expect(classifyTemplatePath('trigger.unknown', vars)).toBe('undeclared');
  });

  it('loop: undeclared when node has no loop context', () => {
    const vars = makeVars({
      loop: null,
    });
    expect(classifyTemplatePath('loop.currentItem', vars)).toBe('undeclared');
  });

  it('loop: valid for declared loop keys including currentItem (sub-path classified as valid root key)', () => {
    const vars = makeVars({
      loop: [
        { key: 'currentIndex', type: 'number', description: '', guaranteed: true },
        { key: 'totalCount', type: 'number', description: '', guaranteed: true },
        {
          key: 'currentItem',
          type: 'unknown',
          description: '',
          guaranteed: true,
        },
      ],
    });
    expect(classifyTemplatePath('loop.currentItem', vars)).toBe('valid');
    expect(classifyTemplatePath('loop.currentItem.title', vars)).toBe('valid');
    expect(classifyTemplatePath('loop.badKey', vars)).toBe('undeclared');
  });

  it('flow: undeclared when node has no flow scope (e.g. primary agent after Start Task)', () => {
    const vars = makeVars({ flow: null });
    expect(classifyTemplatePath('flow.briefing', vars)).toBe('undeclared');
  });

  it('flow: valid when flow scope lists briefing (continuation agent)', () => {
    const vars = makeVars({
      flow: [
        {
          key: 'briefing',
          type: 'string',
          description: '',
          guaranteed: true,
        },
      ],
    });
    expect(classifyTemplatePath('flow.briefing', vars)).toBe('valid');
  });

  it('trims full path before parsing', () => {
    const vars = makeVars({
      previous: [{ key: 'exitCode', type: 'number', description: '', guaranteed: true }],
    });
    expect(classifyTemplatePath('  previous.exitCode  ', vars)).toBe('valid');
  });
});

describe('warningMessageForPlaceholder', () => {
  const vars = makeVars({
    previous: [{ key: 'exitCode', type: 'number', description: '', guaranteed: true }],
    notes: [
      'These dynamic fields can be referenced as {{previous.<fieldName>}} even if not listed above.',
    ],
  });

  it('returns null for valid tone', () => {
    expect(warningMessageForPlaceholder('previous.exitCode', 'valid', vars)).toBeNull();
  });

  it('dynamic tone mentions declared predecessor fields', () => {
    const msg = warningMessageForPlaceholder('previous.prCount', 'dynamic', vars);
    expect(msg).toContain('declared predecessor');
    expect(msg).toContain('previous.exitCode');
  });

  it('dynamic tone for trigger.* explains batch trigger schema and how to declare', () => {
    const msg = warningMessageForPlaceholder('trigger.workstreamId', 'dynamic', vars);
    expect(msg).not.toBeNull();
    expect(msg).toContain('Batch trigger variables');
    expect(msg).toContain('frink_flows_define_stages');
  });

  it('dynamic tone does not throw when vars is undefined (previous.*)', () => {
    const msg = warningMessageForPlaceholder('previous.prCount', 'dynamic', undefined);
    expect(msg).toContain('declared predecessor fields');
    expect(msg).toContain('(none)');
  });

  it('dynamic tone does not throw when vars is undefined (flow.*)', () => {
    const msg = warningMessageForPlaceholder('flow.typo', 'dynamic', undefined);
    expect(msg).toContain('declared flow fields');
    expect(msg).toContain('(none)');
  });

  it('dynamic tone for flow.* uses declared flow fields list when vars.flow is populated', () => {
    const flowVars = makeVars({
      previous: [],
      flow: [
        {
          key: 'briefing',
          type: 'string',
          description: '',
          guaranteed: true,
        },
      ],
    });
    const msg = warningMessageForPlaceholder('flow.typo', 'dynamic', flowVars);
    expect(msg).toContain('declared flow fields');
    expect(msg).toContain('flow.briefing');
  });

  it('dynamic tone for flow.* when vars.flow is empty uses declared flow fields scope with (none), not predecessor keys', () => {
    const emptyFlow = makeVars({
      flow: [],
      previous: [{ key: 'exitCode', type: 'number', description: '', guaranteed: true }],
    });
    const msg = warningMessageForPlaceholder('flow.typo', 'dynamic', emptyFlow);
    expect(msg).toBeDefined();
    expect(msg).toContain('declared flow fields');
    expect(msg).toContain('(none)');
    expect(msg).not.toContain('declared predecessor fields');
    expect(msg).not.toContain('previous.exitCode');
  });

  it('undeclared with empty trigger explains trigger type', () => {
    const manual = makeVars({ trigger: [] });
    const msg = warningMessageForPlaceholder('trigger.scheduledAt', 'undeclared', manual);
    expect(msg).toContain('does not provide template variables');
  });

  it('flow.* is retired — any {{flow.*}} placeholder returns the retired message', () => {
    const msg = warningMessageForPlaceholder(
      'flow.briefing',
      'undeclared',
      makeVars({ flow: null }),
    );
    expect(msg).toContain('retired');
    expect(msg).toContain('reaches every agent automatically');
    expect(msg).not.toContain('continuation agents');
  });

  it('flow.* retired message applies regardless of the placeholder path or vars.flow', () => {
    // computeNodeVariables now always returns flow: null; even a historical populated shape retires.
    const msg = warningMessageForPlaceholder(
      'flow.typo',
      'undeclared',
      makeVars({ flow: [{ key: 'briefing', type: 'string', description: '', guaranteed: true }] }),
    );
    expect(msg).toContain('retired');
    expect(msg).not.toContain('Available flow:');
  });
});

describe('classifyTemplatePath — webhook trigger (raw payload + friendly aliases)', () => {
  // Mirrors the trimmed webhook_trigger schema + an injected provider alias.
  const webhookVars = makeVars({
    trigger: [
      { key: 'source', type: 'string', description: '' },
      { key: 'event', type: 'string', description: '' },
      { key: 'triggeredBy', type: 'object', description: '' },
      { key: 'payload', type: 'object', description: '', openEnded: true },
      { key: 'story.title', type: 'string', description: 'Story title' },
      { key: 'story.id', type: 'number', description: 'Story ID' },
    ],
  });

  it('payload sub-paths are dynamic (open-ended raw body), not confident-valid', () => {
    expect(classifyTemplatePath('trigger.payload.actions.0.name', webhookVars)).toBe('dynamic');
    expect(classifyTemplatePath('trigger.payload', webhookVars)).toBe('valid');
  });

  it('structured object sub-paths (triggeredBy.externalUserId) stay valid', () => {
    expect(classifyTemplatePath('trigger.triggeredBy.externalUserId', webhookVars)).toBe('valid');
  });

  it('friendly aliases are valid; typos within an alias namespace are undeclared', () => {
    expect(classifyTemplatePath('trigger.story.title', webhookVars)).toBe('valid');
    expect(classifyTemplatePath('trigger.story.typo', webhookVars)).toBe('undeclared');
  });

  it('removed fields (sourceAccountName) are undeclared (red), not silently valid', () => {
    expect(classifyTemplatePath('trigger.sourceAccountName', webhookVars)).toBe('undeclared');
  });

  it('the dynamic message for payload points at the raw body + a friendly field', () => {
    const msg = warningMessageForPlaceholder(
      'trigger.payload.actions.0.name',
      'dynamic',
      webhookVars,
    );
    expect(msg).toContain('raw webhook body');
    expect(msg).toContain('trigger.story.title');
  });
});
