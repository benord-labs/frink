import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoundName } from './play-chime';

/**
 * The sound family shares a module-level AudioContext singleton, so each test
 * resets modules and installs a fresh fake context before a dynamic import.
 * We assert scheduled frequencies because the family's guarantees are pitch
 * guarantees — e.g. "failure is the only dissonance" is exactly the semitone
 * cluster below, and no success sound may schedule it.
 */
type FakeOscillator = {
  type: string;
  frequency: { setValueAtTime: ReturnType<typeof vi.fn> };
  detune: { setValueAtTime: ReturnType<typeof vi.fn> };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

type FakeGain = {
  gain: {
    value: number;
    setValueAtTime: ReturnType<typeof vi.fn>;
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
};

let oscillators: FakeOscillator[] = [];
let noteGains: FakeGain[] = [];
let contexts: Array<{ state: string }> = [];
let resumeMock: ReturnType<typeof vi.fn>;

function installFakeAudioContext(state: 'running' | 'suspended' = 'suspended') {
  oscillators = [];
  noteGains = [];
  contexts = [];
  resumeMock = vi.fn().mockResolvedValue(undefined);

  class FakeAudioContext {
    state = state;
    currentTime = 0;
    sampleRate = 44100;
    destination = {};
    resume = resumeMock;
    constructor() {
      contexts.push(this);
    }
    createOscillator(): FakeOscillator {
      const osc: FakeOscillator = {
        type: '',
        frequency: { setValueAtTime: vi.fn() },
        detune: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    }
    createGain(): FakeGain {
      const gain: FakeGain = {
        gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      };
      noteGains.push(gain);
      return gain;
    }
    createConvolver() {
      return { buffer: null, connect: vi.fn() };
    }
    createBuffer(_channels: number, length: number) {
      return { getChannelData: () => new Float32Array(length) };
    }
  }

  vi.stubGlobal('AudioContext', FakeAudioContext);
}

function scheduledHz(): number[] {
  return oscillators.map((o) => o.frequency.setValueAtTime.mock.calls[0][0] as number);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('playSound — the family gestures', () => {
  // [sound, expected fundamentals (shimmer voices double each note)]
  const PLAIN: Array<[SoundName, number[]]> = [
    ['started', [329.63, 659.25]],
    ['turnComplete', [440, 880]],
    ['batchDone', [329.63, 659.25, 1318.51, 1318.51, 987.77]],
    ['parked', [1318.51, 987.77]],
  ];
  const SHIMMERED: Array<[SoundName, number[]]> = [
    ['flowComplete', [659.25, 987.77, 1318.51]],
    ['needsYou', [440, 440]],
    ['failed', [220, 233.08, 174.61, 185]],
  ];

  it.each(PLAIN)('%s schedules its notes once, un-shimmered', async (name, hz) => {
    installFakeAudioContext('running');
    const { playSound } = await import('./play-chime');

    await playSound(name);

    expect(scheduledHz()).toEqual(hz);
    for (const osc of oscillators) {
      expect(osc.detune.setValueAtTime).not.toHaveBeenCalled();
    }
  });

  it.each(SHIMMERED)('%s layers a +6-cent shimmer voice per note', async (name, hz) => {
    installFakeAudioContext('running');
    const { playSound } = await import('./play-chime');

    await playSound(name);

    // Each note = main voice + shimmer voice at the same fundamental.
    expect(scheduledHz()).toEqual(hz.flatMap((f) => [f, f]));
    const detuned = oscillators.filter((o) => o.detune.setValueAtTime.mock.calls.length > 0);
    expect(detuned).toHaveLength(hz.length);
    for (const osc of detuned) {
      expect(osc.detune.setValueAtTime).toHaveBeenCalledWith(6, expect.any(Number));
    }
  });

  it('keeps the dissonant semitone cluster exclusive to failed', async () => {
    installFakeAudioContext('running');
    const { playSound } = await import('./play-chime');

    const successSounds: SoundName[] = ['started', 'turnComplete', 'flowComplete', 'batchDone'];
    for (const name of successSounds) {
      oscillators = [];
      await playSound(name);
      expect(scheduledHz()).not.toContain(233.08);
      expect(scheduledHz()).not.toContain(185);
    }
  });

  it('resumes a suspended AudioContext before playing', async () => {
    installFakeAudioContext('suspended');
    const { playSound } = await import('./play-chime');

    await playSound('turnComplete');

    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(oscillators).toHaveLength(2);
  });

  it('fails silently when AudioContext is unavailable', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const { playSound } = await import('./play-chime');

    await expect(playSound('turnComplete')).resolves.toBeUndefined();
  });
});

describe('playSound — volume boundaries and context recovery', () => {
  function peakGains(): number[] {
    // First setValueAtTime call on each NOTE gain is the attack peak (the
    // reverb-send gain never receives setValueAtTime — filter it out).
    return noteGains
      .filter((g) => g.gain.setValueAtTime.mock.calls.length > 0)
      .map((g) => g.gain.setValueAtTime.mock.calls[0][0] as number);
  }

  it('volume 0 stays schedulable (exponential ramps need a positive floor)', async () => {
    installFakeAudioContext('running');
    const { playSound } = await import('./play-chime');

    await playSound('turnComplete', { volume: 0 });

    expect(oscillators).toHaveLength(2);
    for (const peak of peakGains()) {
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(0.0004);
    }
  });

  it('clamps an out-of-range volume to 1 — no gain spike from a bad caller', async () => {
    installFakeAudioContext('running');
    const { playSound } = await import('./play-chime');

    await playSound('turnComplete', { volume: Number.MAX_SAFE_INTEGER });

    // turnComplete's designed gains are 0.9 and 1 — nothing may exceed them.
    for (const peak of peakGains()) {
      expect(peak).toBeLessThanOrEqual(1);
    }
  });

  it('negative volume clamps to the silent floor instead of throwing', async () => {
    installFakeAudioContext('running');
    const { playSound } = await import('./play-chime');

    await expect(playSound('turnComplete', { volume: -1 })).resolves.toBeUndefined();
    expect(oscillators).toHaveLength(2);
    for (const peak of peakGains()) {
      expect(peak).toBeGreaterThan(0);
    }
  });

  it('rebuilds the graph after the context dies (audio device churn)', async () => {
    installFakeAudioContext('running');
    const { playSound } = await import('./play-chime');

    await playSound('turnComplete');
    expect(oscillators).toHaveLength(2);

    // The OS killed the context under us: a cached 'closed' context must not
    // silence every future sound until app restart.
    contexts[0].state = 'closed';
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(2001);
      await playSound('turnComplete');
    } finally {
      vi.useRealTimers();
    }

    expect(contexts).toHaveLength(2);
    expect(oscillators).toHaveLength(4);
  });
});

describe('playSound — per-sound coalescing', () => {
  it('coalesces a same-sound burst into a single play (parallel agents)', async () => {
    installFakeAudioContext('suspended');
    const { playSound } = await import('./play-chime');

    // Concurrent same-tick calls overlapping while resume() is still pending:
    // the guard must trip before any await, not after.
    await Promise.all([
      playSound('turnComplete'),
      playSound('turnComplete'),
      playSound('turnComplete'),
    ]);

    expect(oscillators).toHaveLength(2);
  });

  it('never swallows one sound behind another — cooldowns are independent', async () => {
    installFakeAudioContext('running');
    const { playSound } = await import('./play-chime');

    await playSound('turnComplete');
    await playSound('failed');

    // A completion immediately followed by a failure must play BOTH.
    expect(scheduledHz()).toContain(880);
    expect(scheduledHz()).toContain(174.61);
  });

  it('does not consume the cooldown when playback fails', async () => {
    installFakeAudioContext('suspended');
    resumeMock.mockRejectedValueOnce(new Error('no user gesture yet'));
    const { playSound } = await import('./play-chime');

    await playSound('turnComplete');
    expect(oscillators).toHaveLength(0);

    // The failed attempt released its claim, so the next attempt plays.
    await playSound('turnComplete');
    expect(oscillators).toHaveLength(2);
  });

  it('plays again once the cooldown has elapsed', async () => {
    vi.useFakeTimers();
    try {
      installFakeAudioContext('running');
      const { playSound } = await import('./play-chime');

      await playSound('turnComplete');
      vi.advanceTimersByTime(2001);
      await playSound('turnComplete');

      // The cooldown coalesces bursts, it is not a one-shot mute.
      expect(oscillators).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
