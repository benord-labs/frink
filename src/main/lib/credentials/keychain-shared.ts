/**
 * Shared keychain constants.
 *
 * Both `detect.ts` and `source-readers.ts` shell out to `security` /
 * `secret-tool` and need the same timeout. Pulling this into a third module
 * avoids the circular import that would otherwise form (`source-readers` ↔
 * `detect`).
 */

/**
 * Hard cap on every `security find-generic-password` / `security dump-keychain`
 * / `secret-tool lookup` invocation. Anything past this is treated as a
 * denial — transient: nothing is persisted, and the next resolution re-probes.
 *
 * 1500ms balances "slow on a busy machine" vs "let the chat-send hang while a
 * locked keychain blocks". See `source-readers.resolveDarwinKeychain` and
 * pre-commit backend-perf review (May 2026).
 */
export const KEYCHAIN_READ_TIMEOUT_MS = 1500;
