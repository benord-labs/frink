import { describe, expect, it } from 'vitest';
import type { MobileFlowDefinition } from '@frink/shared/types/remote/mobile';
import { outlineSteps } from './outline';

const step = (id: string, blockType = 'agent', parentId: string | null = null) => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
  blockType,
  parentId,
  instructions: null,
});
const edge = (source: string, target: string, label: string | null = null, handle = null) => ({
  id: `${source}-${target}`,
  source,
  target,
  label,
  sourceHandle: handle as string | null,
});

const lines = (definition: MobileFlowDefinition) =>
  Object.fromEntries(
    outlineSteps(definition).map((s) => [
      s.node.id,
      s.lines.map((l) => `${l.kind}: ${l.text}${l.target ? ` ${l.target}` : ''}`),
    ]),
  );

describe('outlineSteps', () => {
  it('keeps a straight Flow quiet: order says what runs next', () => {
    const definition = {
      versionNumber: 1,
      nodes: [step('start', 'schedule_trigger'), step('update'), step('test')],
      edges: [edge('start', 'update'), edge('update', 'test')],
    };
    expect(lines(definition)).toEqual({ start: [], update: [], test: [] });
    expect(outlineSteps(definition).map((s) => s.type)).toEqual([
      'Schedule trigger',
      'Agent',
      'Agent',
    ]);
  });

  it('spells out branches, loops, joins and path ends', () => {
    const definition = {
      versionNumber: 4,
      nodes: [step('review'), step('decide', 'condition'), step('prepare'), step('summary')],
      edges: [
        edge('review', 'decide'),
        edge('decide', 'prepare', 'Ready'),
        edge('decide', 'review', 'Needs changes'),
        edge('decide', 'summary', 'No work needed'),
        edge('prepare', 'summary'),
      ],
    };
    expect(lines(definition)).toEqual({
      review: [],
      decide: [
        'branch: Ready: Prepare',
        'loop: Needs changes · Returns to Review',
        'branch: No work needed: Summary',
      ],
      prepare: [],
      summary: ['note: Joins from Decide · Prepare', 'note: End of this path'],
    });
  });

  it('names nesting, jumps, unknown blocks and unconnected steps', () => {
    const definition = {
      versionNumber: 2,
      nodes: [step('fan', 'fan_out'), step('child', 'agent', 'fan'), step('lost', 'mystery_block')],
      edges: [edge('fan', 'lost')],
    };
    expect(lines(definition)).toEqual({
      fan: ['jump: Then Lost'],
      child: ['note: Inside Fan'],
      lost: [],
    });
    expect(outlineSteps(definition).map((s) => s.type)).toEqual([
      'Fan out',
      'Agent',
      'Mystery block',
    ]);
    const http = {
      versionNumber: 1,
      nodes: [step('call', 'http_request'), step('after', 'post_task_trigger')],
      edges: [],
    };
    expect(outlineSteps(http).map((s) => s.type)).toEqual(['HTTP request', 'Post-task trigger']);
    const loose = { versionNumber: 1, nodes: [step('a'), step('b')], edges: [] };
    expect(lines(loose)).toEqual({ a: ['note: Not connected'], b: ['note: Not connected'] });
  });
});
