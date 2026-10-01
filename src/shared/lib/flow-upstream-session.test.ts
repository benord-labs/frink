import { describe, expect, it } from 'vitest';
import {
  AGENT_SESSION_SOURCES,
  CHAT_REPLY_SESSION_SOURCES,
  findUpstreamSession,
} from './flow-upstream-session';

// st? → f[st-lane → a-lane] → after
const NODES = [
  { id: 'st', blockType: 'start_task' },
  { id: 'f', blockType: 'fan_out' },
  { id: 'st-lane', blockType: 'start_task', parentId: 'f' },
  { id: 'a-lane', blockType: 'agent', parentId: 'f' },
  { id: 'after', blockType: 'chat_reply' },
];
const LANE_EDGES = [
  { source: 'f', target: 'st-lane' },
  { source: 'st-lane', target: 'a-lane' },
  { source: 'a-lane', target: 'after' },
];
const node = (id: string) => NODES.find((n) => n.id === id) as (typeof NODES)[number];

describe('findUpstreamSession', () => {
  it('finds an outer Start Task by walking through the lane body', () => {
    const edges = [{ source: 'st', target: 'f' }, ...LANE_EDGES];
    expect(findUpstreamSession(NODES, edges, node('after'), CHAT_REPLY_SESSION_SOURCES)).toBe(
      'found',
    );
  });

  it('reports lane-only when every source sits inside a Fan Out lane', () => {
    expect(findUpstreamSession(NODES, LANE_EDGES, node('after'), AGENT_SESSION_SOURCES)).toBe(
      'lane-only',
    );
  });

  it('lets a lane node use a source in its own lane', () => {
    expect(findUpstreamSession(NODES, LANE_EDGES, node('a-lane'), CHAT_REPLY_SESSION_SOURCES)).toBe(
      'found',
    );
  });

  it('reports none with no source upstream, and survives a cycle', () => {
    const edges = [
      { source: 'after', target: 'f' },
      { source: 'f', target: 'after' },
    ];
    expect(findUpstreamSession(NODES, edges, node('after'), CHAT_REPLY_SESSION_SOURCES)).toBe(
      'none',
    );
  });
});
