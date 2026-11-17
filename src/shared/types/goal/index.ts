/** A Claude `/goal` read from its own transcript, kept on a persisted `data-goal` part. `checked`:
 * an evaluator verdict seen without the goal itself, i.e. a goal set in an earlier turn. */
export type GoalPartData =
  | {
      state: 'active' | 'checked';
      objective: string;
      /** The evaluator's latest reason the goal is not met yet. */
      lastCheck?: string;
    }
  | { state: 'cleared' }
  /** One per turn end. `deferred`: background work was still running, so Claude skipped the check. */
  | { state: 'stopped'; deferred: boolean };
