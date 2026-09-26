// Decision flow-editor-unsaved-changes-persistence: baselineVersion never advances without its graph.

/** The one field the decision reads. Generic so callers get their own DTO back, fully typed. */
export type VersionedFlowSnapshot = {
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  version_number: number | null;
};

export type ServerAdoptionInput<TSnapshot extends VersionedFlowSnapshot> = {
  /** The latest `flows.get` response, or undefined before it lands. */
  data: TSnapshot | undefined;
  /** False until the editor's first hydration has run. */
  hydrated: boolean;
  /** Working copy differs from the graph `baselineVersion` describes — derived, never latched. */
  locallyModified: boolean;
  /** A live or rehearsed run is painted on the canvas, keyed to the node ids currently on screen. */
  runOnCanvas: boolean;
  /** The version the editor's working copy was taken from. */
  baselineVersion: number;
};

export function resolveServerAdoption<TSnapshot extends VersionedFlowSnapshot>({
  data,
  hydrated,
  locallyModified,
  runOnCanvas,
  baselineVersion,
}: ServerAdoptionInput<TSnapshot>): TSnapshot | null {
  if (!data || !hydrated || locallyModified || runOnCanvas) return null;
  // Forward-only: the post-save cached response still reports the older version.
  if ((data.version_number ?? 0) <= baselineVersion) return null;
  return data;
}
