import { describe, expect, it } from 'vitest';

import {
  classifyProcessGoneReason,
  findRendererOomEvidence,
  ownsRendererDeath,
} from './process-gone-diagnostics';

describe('classifyProcessGoneReason', () => {
  it('labels only Electron oom as confirmed OOM', () => {
    expect(classifyProcessGoneReason('oom')).toEqual({
      classification: 'confirmed_oom',
      confirmedOom: true,
      level: 'fatal',
    });
  });

  it.each([
    ['memory-eviction', 'memory_eviction', 'error'],
    ['crashed', 'unexpected_crash', 'fatal'],
    ['abnormal-exit', 'abnormal_exit', 'error'],
    ['killed', 'external_kill', 'error'],
    ['launch-failed', 'launch_failure', 'error'],
    ['integrity-failure', 'integrity_failure', 'fatal'],
    ['clean-exit', 'clean_exit', 'warning'],
  ] as const)('keeps %s distinct from OOM', (reason, classification, level) => {
    expect(classifyProcessGoneReason(reason)).toEqual({
      classification,
      confirmedOom: false,
      level,
    });
  });

  it('keeps an unknown future Electron reason observable but unclassified', () => {
    expect(classifyProcessGoneReason('future-reason')).toEqual({
      classification: 'unknown_process_exit',
      confirmedOom: false,
      level: 'error',
    });
  });
});

describe('findRendererOomEvidence', () => {
  it.each([
    [
      'Blink PartitionAlloc key plus Electron process_type',
      { 'page-allocator-mapped-size': '43487285248', process_type: 'renderer' },
      {
        allocator: 'partition-alloc',
        crashKey: 'page-allocator-mapped-size',
        crashKeyValue: '43487285248',
      },
    ],
    [
      'Electron V8 keys plus Chromium ptype',
      {
        'electron.v8-oom.location': 'MarkCompactCollector: young object promotion failed',
        'v8-oom-stack': 'repeat',
        ptype: 'renderer',
      },
      {
        allocator: 'v8',
        crashKey: 'electron.v8-oom.location',
        crashKeyValue: 'MarkCompactCollector: young object promotion failed',
      },
    ],
  ])('confirms a renderer OOM from %s', (_label, annotations, evidence) => {
    expect(findRendererOomEvidence(annotations)).toEqual(evidence);
  });

  it.each([
    ['a GPU dump', { 'page-allocator-mapped-size': '1', process_type: 'gpu-process' }],
    ['no process-type key', { 'page-allocator-mapped-size': '1' }],
    ['no OOM crash key', { process_type: 'renderer', v8_isolate_address: '0x1' }],
    ['only V8 detail keys without the location', { process_type: 'renderer', 'v8-oom-stack': 'x' }],
    ['no annotations', {}],
  ])('yields nothing for %s', (_label, annotations) => {
    expect(findRendererOomEvidence(annotations)).toBeNull();
  });
});

describe('ownsRendererDeath', () => {
  it.each([
    ['a renderer dump whose pid is the dead renderer', { ptype: 'renderer', pid: '55504' }, true],
    [
      'a dump either process-type key calls a renderer',
      { process_type: 'browser', ptype: 'renderer', pid: '55504' },
      true,
    ],
    ['a renderer dump without a pid annotation', { process_type: 'renderer' }, false],
    ['a renderer dump from another renderer', { process_type: 'renderer', pid: '2' }, false],
    ['a GPU dump with the same pid', { process_type: 'gpu-process', pid: '55504' }, false],
    ['a dump without a process type', { pid: '55504' }, false],
  ])('%s', (_label, annotations, owns) => {
    expect(ownsRendererDeath(annotations, 55504)).toBe(owns);
  });
});
