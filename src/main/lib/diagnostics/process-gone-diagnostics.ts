import type { CrashpadAnnotations } from './minidump-annotations';

type ProcessGoneClassification =
  | 'confirmed_oom'
  | 'memory_eviction'
  | 'unexpected_crash'
  | 'abnormal_exit'
  | 'external_kill'
  | 'launch_failure'
  | 'integrity_failure'
  | 'clean_exit'
  | 'unknown_process_exit';

export type ProcessGoneAssessment = {
  classification: ProcessGoneClassification;
  confirmedOom: boolean;
  level: 'fatal' | 'error' | 'warning';
};

/** Electron's reason is authoritative; an exit code or dirty shutdown never upgrades to OOM. */
export function classifyProcessGoneReason(reason: string): ProcessGoneAssessment {
  switch (reason) {
    case 'oom':
      return { classification: 'confirmed_oom', confirmedOom: true, level: 'fatal' };
    case 'memory-eviction':
      return { classification: 'memory_eviction', confirmedOom: false, level: 'error' };
    case 'crashed':
      return { classification: 'unexpected_crash', confirmedOom: false, level: 'fatal' };
    case 'abnormal-exit':
      return { classification: 'abnormal_exit', confirmedOom: false, level: 'error' };
    case 'killed':
      return { classification: 'external_kill', confirmedOom: false, level: 'error' };
    case 'launch-failed':
      return { classification: 'launch_failure', confirmedOom: false, level: 'error' };
    case 'integrity-failure':
      return { classification: 'integrity_failure', confirmedOom: false, level: 'fatal' };
    case 'clean-exit':
      return { classification: 'clean_exit', confirmedOom: false, level: 'warning' };
    default:
      return { classification: 'unknown_process_exit', confirmedOom: false, level: 'error' };
  }
}

/**
 * The two crash keys Chromium sets right before a renderer traps on out-of-memory: Blink before
 * every PartitionAlloc path, Electron's own V8 OOM handler before `OOM_CRASH`.
 */
const OOM_CRASH_KEYS = {
  'page-allocator-mapped-size': 'partition-alloc',
  'electron.v8-oom.location': 'v8',
} as const;
/** Electron writes `process_type`; Chromium's generic crash key is `ptype`. */
const PROCESS_TYPE_KEYS = ['process_type', 'ptype'];

export type RendererOomEvidence = {
  allocator: 'partition-alloc' | 'v8';
  crashKey: string;
  crashKeyValue: string;
};

/** Fails closed: a dump without a recognised process-type key is never treated as a renderer's. */
function isRendererDump(annotations: CrashpadAnnotations): boolean {
  return PROCESS_TYPE_KEYS.some((key) => annotations[key] === 'renderer');
}

/** A renderer's dump whose `pid` annotation is the dead renderer's pid recorded while it was alive. */
export function ownsRendererDeath(annotations: CrashpadAnnotations, rendererPid: number): boolean {
  return isRendererDump(annotations) && Number(annotations.pid) === rendererPid;
}

/** The OOM crash key on a renderer's dump, with the allocator it names; null when neither key is set. */
export function findRendererOomEvidence(
  annotations: CrashpadAnnotations,
): RendererOomEvidence | null {
  if (!isRendererDump(annotations)) return null;
  for (const [crashKey, allocator] of Object.entries(OOM_CRASH_KEYS)) {
    if (crashKey in annotations) {
      return { allocator, crashKey, crashKeyValue: annotations[crashKey] };
    }
  }
  return null;
}
