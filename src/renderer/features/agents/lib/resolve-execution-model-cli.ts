/**
 * Maps UI picker model ids to execution `settings.model` strings. Lives in shared so main (the
 * phone's sends) and the renderer resolve identically; re-exported for renderer importers.
 */
export {
  type ExecutionAccountKind,
  resolveExecutionModelCliString,
} from '../../../../shared/lib/execution-settings';
export { supportsNativeAutoReview } from '../../../../shared/lib/models';
