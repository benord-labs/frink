import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import log from 'electron-log';

/** Quotes text for a POSIX shell, so it reaches the command as one argument, unchanged. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The script an agent uses as its shell: it runs a command only when the ledger holds that exact
 * command, consuming the entry, and puts back the user's own environment first. It holds no secret.
 */
export function commandGateScript(opts: {
  realShell: string;
  ledgerDir: string;
  restore: Record<string, string | null>;
}): string {
  const restore = Object.entries(opts.restore).map(([name, value]) =>
    value === null ? `      unset ${name}` : `      export ${name}=${shellQuote(value)}`,
  );
  const claimed = `${shellQuote(opts.ledgerDir)}/.$$`;
  return [
    '#!/bin/sh',
    'if [ "$#" -eq 2 ] && [ "$1" = "-c" ]; then',
    `  for entry in ${shellQuote(opts.ledgerDir)}/*; do`,
    '    [ -f "$entry" ] || continue',
    // Absolute paths, so no program on the agent's PATH runs; the x keeps trailing newlines.
    '    if [ "$(/bin/cat "$entry"; printf x)" = "$2"x ]; then',
    // Only one shell can rename the entry, so two calls never share one allow; macOS rm can
    // report success to every shell racing to remove the same file.
    `      /bin/mv -f "$entry" ${claimed} 2>/dev/null || continue`,
    `      /bin/rm -f ${claimed}`,
    ...restore,
    `      exec ${shellQuote(opts.realShell)} -c "$2"`,
    '    fi',
    '  done',
    'fi',
    'echo "Frink did not approve this command, so it did not run." >&2',
    'exit 126',
    '',
  ].join('\n');
}

/** The commands Frink allowed in one turn, one file per call, read by the shell gate script. */
export function createCommandLedger(dir: string) {
  const entry = (toolCallId: string) => path.join(dir, Buffer.from(toolCallId).toString('hex'));
  // In order, so an entry is never removed by a step that was asked for before it was written.
  let pending = Promise.resolve();
  const queue = (step: () => Promise<void>) => {
    const done = pending.then(step);
    pending = done.catch(() => {});
    return done;
  };
  const removing = (step: () => Promise<void>) =>
    queue(step).catch((error) => log.warn('[ACP] Could not remove an allowed command', error));
  return {
    /** Settles once the command is written; it rejects when it could not be. */
    hold: (toolCallId: string, command: string) =>
      queue(() => writeFile(entry(toolCallId), command, { mode: 0o600 })),
    release: (toolCallId: string) => removing(() => rm(entry(toolCallId), { force: true })),
    clear: () =>
      removing(async () => {
        for (const name of await readdir(dir)) await rm(path.join(dir, name), { force: true });
      }),
  };
}

export type CommandLedger = ReturnType<typeof createCommandLedger>;
