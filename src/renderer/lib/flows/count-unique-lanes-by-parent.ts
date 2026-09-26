/**
 * Counts unique `lane_index` values per `parent_fan_out_node_run_id`.
 * Parallel fan-out creates one row per (lane × body node); counting rows would
 * over-count (e.g. 3 lanes × 2 body nodes = 6 rows but only 3 lanes).
 * Typed structurally (lane columns only) so this lib module never imports src/main types.
 */
export function countUniqueLanesByParent(
  nodeRuns: ReadonlyArray<{
    // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
    parent_fan_out_node_run_id: string | null;
    // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
    lane_index: number | null;
  }>,
): Map<string, number> {
  const uniqueLanes = new Map<string, Set<number>>();
  for (const n of nodeRuns) {
    if (n.parent_fan_out_node_run_id != null && n.lane_index != null) {
      const p = n.parent_fan_out_node_run_id;
      let set = uniqueLanes.get(p);
      if (!set) {
        set = new Set();
        uniqueLanes.set(p, set);
      }
      set.add(n.lane_index);
    }
  }
  const counts = new Map<string, number>();
  for (const [p, set] of uniqueLanes) {
    counts.set(p, set.size);
  }
  return counts;
}
