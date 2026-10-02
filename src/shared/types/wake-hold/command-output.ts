/** The live tail of a running command's output, pulled while the user has its details open. */
export type CommandOutputTail = {
  /** How long it has been running; null when that cannot be read. */
  runningForMs: number | null;
  /** Its latest output, control sequences stripped; null when the output cannot be read. */
  text: string | null;
};
