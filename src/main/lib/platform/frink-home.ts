import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';

/** `$FRINK_HOME` for an isolated instance, else the real home; boundary in `provider-config-canonical-home`. */
export function frinkUserHome(): string {
  return configuredHome() ?? os.homedir();
}

/** `$FRINK_HOME` when it names something; blank is not an override, it is an absent one. */
function configuredHome(): string | undefined {
  return process.env.FRINK_HOME?.trim() || undefined;
}

/** Canonical form for comparison: resolves the macOS `/var` → `/private/var` alias. */
function canonical(dir: string): string {
  return existsSync(dir) ? realpathSync.native(dir) : dir;
}

/** Refuse to boot an isolated instance (`FRINK_CDP_PORT`) that would write the operator's home (sc-2903). */
export function assertRigHomeIsolated(): void {
  if (!process.env.FRINK_CDP_PORT) return;
  const configured = configuredHome();
  const fix = 'Point FRINK_HOME at a directory owned by that isolated instance.';
  if (!configured) {
    throw new Error(
      `Refusing to boot: an isolated instance (FRINK_CDP_PORT) has no FRINK_HOME, so it would write the operator's ~/.frink. ${fix}`,
    );
  }
  if (!existsSync(configured)) {
    throw new Error(
      `Refusing to boot: FRINK_HOME "${configured}" does not exist — create and seed it first. ${fix}`,
    );
  }
  if (canonical(configured) === canonical(os.homedir())) {
    throw new Error(
      `Refusing to boot: FRINK_HOME "${configured}" resolves to the operator's real home. ${fix}`,
    );
  }
}
