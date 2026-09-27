// Shared `security` timeout for detect.ts and source-readers.ts; a third module avoids
// the circular import `source-readers` ↔ `detect`.

/**
 * Hard cap on every `security find-generic-password` / `security dump-keychain`
 * invocation. Anything past this is treated as a denial — transient: nothing is
 * persisted, and the next resolution re-probes.
 *
 * 1500ms balances "slow on a busy machine" vs "let the chat-send hang while a
 * locked keychain blocks". See `source-readers.resolveDarwinKeychain` and
 * pre-commit backend-perf review (May 2026).
 */
export const KEYCHAIN_READ_TIMEOUT_MS = 1500;
