/**
 * Wake-hold types, shared because both processes need them: main publishes the state, the renderer
 * stores and renders it. Its own folder rather than a flat `wake-hold.ts` only because
 * `src/shared/types` sits at its grandfathered fan-out ceiling (13) — a cohesive kebab subfolder is
 * what that gate prescribes, and it beats misfiling these under an unrelated existing filename.
 *
 * What a held chat is waiting on, as published to the renderer alongside the held flag.
 *
 * Refreshed at every wake burst rather than frozen at arming time: the Stop hook rewrites its
 * pending-work snapshot on the first line of EVERY stop, including each burst's own, so this is
 * live as of the last wake. (An arming-time snapshot would only ever shrink into a lie — which is
 * why the held row carried no detail before.)
 */
export type WakeHoldState = {
  /**
   * One human label per in-flight item, e.g. `['Monitor', 'Command']`. Never empty: a hold is only
   * ever armed with at least one pending item.
   */
  waitingOn: string[];
};

/**
 * The `socket:wake-hold-changed` wire shape. Named here rather than inline at the sender so the
 * main-process broadcaster and the wake pump's IO adapter cannot drift on it.
 *
 * `pending` rides only on a held:true — absent on a retraction, and on a hold with no Stop hook to
 * ask. The renderer re-narrows this at the IPC boundary (the data arrives as `unknown`) and enforces
 * the held/pending pairing there.
 */
export type WakeHoldChangedPayload = {
  chatId: string;
  subChatId: string;
  held: boolean;
  pending?: WakeHoldState;
  endReason?: WakeHoldEndReason;
};

/** 'wait-over' when the wait's own liveness rule ends it (onWaitOver); 'adopted' when a follow-up
 * turn takes the hold over; 'failed' when the pump dies. Every other retraction omits it. */
export type WakeHoldEndReason = 'wait-over' | 'adopted' | 'failed';
