export type SharedFinallyCleanupInput = {
  ensureTerminalTaskSignal: () => Promise<void>;
  handleTerminalTaskSignalPersistError: (error: unknown) => void;
  safeComplete: () => void;
};

export async function sharedFinallyCleanup({
  ensureTerminalTaskSignal,
  handleTerminalTaskSignalPersistError,
  safeComplete,
}: SharedFinallyCleanupInput): Promise<void> {
  try {
    await ensureTerminalTaskSignal();
  } catch (error) {
    try {
      handleTerminalTaskSignalPersistError(error);
    } catch {
      // Keep final cleanup non-throwing even if persist-error reporting fails.
    }
  } finally {
    safeComplete();
  }
}
