/**
 * Batch stage helpers split out of the flat flows/ folder: dependency-branch inheritance for
 * dependent stages (sc-3845).
 */

export { mergeDependencyBranches, resolveDependencyBranches } from './dependency-branches';
export { type BatchStatusBuckets, bucketBatchStatusCounts } from './status-buckets';
