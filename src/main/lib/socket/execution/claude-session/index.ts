/** A Claude CLI's spawn identity, and the SDK callbacks it runs with, scoped to its session. */
export { attachTurn } from './attach';
export { persistEarlySessionId } from './persist-session-id';
export { computeClaudeSessionKey } from './session-key';
export {
  _resetClaudeDebugSessionsForTests,
  buildClaudeSessionSpec,
  prepareClaudeSpawn,
  releaseClaudeDebugSession,
  spawnClaudeSession,
} from './session-spec';
