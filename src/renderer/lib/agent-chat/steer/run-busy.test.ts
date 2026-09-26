import { afterEach, describe, expect, it } from 'vitest';
import { appStore } from '../../jotai-store';
import { runLiveAtomFamily, runSettlingAtomFamily } from '../../stores/active-transport-registry';
import {
  _resetLiveRunHydrationForTests,
  beginLiveRunHydration,
} from '../../stores/renderer-recovery-ready';
import { isRunBusy, isRunSettling } from './run-busy';

const SUB = 'sub-run-busy';

describe('isRunBusy', () => {
  afterEach(() => {
    appStore.set(runLiveAtomFamily(SUB), false);
    _resetLiveRunHydrationForTests();
  });

  it('is idle only when the renderer, main and boot hydration all agree', () => {
    expect(isRunBusy(SUB, false)).toBe(false);
  });

  it('is busy while the renderer streams', () => {
    expect(isRunBusy(SUB, true)).toBe(true);
  });

  it('is busy while main still runs the turn though the renderer reads idle', () => {
    appStore.set(runLiveAtomFamily(SUB), true);

    expect(isRunBusy(SUB, false)).toBe(true);
  });

  it('is busy until main’s surviving runs have been hydrated', () => {
    beginLiveRunHydration();

    expect(isRunBusy(SUB, false)).toBe(true);
  });
});

describe('isRunSettling', () => {
  afterEach(() => {
    appStore.set(runLiveAtomFamily(SUB), false);
    appStore.set(runSettlingAtomFamily(SUB), false);
    _resetLiveRunHydrationForTests();
  });

  it('holds only once main has completed the turn, not merely while it runs one', () => {
    appStore.set(runLiveAtomFamily(SUB), true); // e.g. a reopened chat whose run is mid-tool
    expect(isRunSettling(SUB)).toBe(false);

    appStore.set(runSettlingAtomFamily(SUB), true);
    expect(isRunSettling(SUB)).toBe(true);
  });

  it('does not hold until main’s surviving runs have been hydrated', () => {
    appStore.set(runSettlingAtomFamily(SUB), true);
    beginLiveRunHydration();

    expect(isRunSettling(SUB)).toBe(false);
  });
});
