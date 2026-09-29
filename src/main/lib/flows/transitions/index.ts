/** Flow-run lifecycle changes as synchronous commands: no await and no admission controller, runtime
 * or drain call inside one. Invariants: docs/decisions/flow-run-transition-serialization.md. */
import type { getDatabase } from '../../db';

export { cancelRunRows, insertNodeRunIfLive } from './run-rows';

type Db = ReturnType<typeof getDatabase>;

export function runTransition<T>(db: Db, command: () => T): T {
  return db.transaction(command, { behavior: 'immediate' });
}
