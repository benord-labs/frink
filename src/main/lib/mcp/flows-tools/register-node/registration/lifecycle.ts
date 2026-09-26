import { join, resolve } from 'node:path';
import type { InstalledPackageState } from '../package';
import { registerNodeDependencies } from '../register-node-dependencies';

const STAGING_DIRECTORY = '.frink-register-staging';
let preparedRegistrationInFlight = false;

export function installedStatesMatch(
  first: InstalledPackageState | null,
  second: InstalledPackageState | null,
): boolean {
  return first?.digest === second?.digest && (first === null) === (second === null);
}

/** Mirrors `FRINK_CUSTOM_NODES_DIR` so registration writes where discovery and the permission root read. */
export function defaultNodesRoot(): string {
  // resolve() like the canonical constant: resolve-input compares an absolute path against this.
  return resolve(
    process.env.FRINK_CUSTOM_NODES_DIR ??
      join(registerNodeDependencies.frinkUserHome(), '.frink', 'nodes'),
  );
}

function stagingRootPath(nodesRoot: string): string {
  return join(nodesRoot, STAGING_DIRECTORY);
}

export function beginPreparedRegistration(): (() => void) | null {
  if (preparedRegistrationInFlight) return null;
  preparedRegistrationInFlight = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    preparedRegistrationInFlight = false;
  };
}

export function registrationAborted(signal?: AbortSignal): { ok: false; error: string } | null {
  return signal?.aborted ? { ok: false, error: 'Custom node registration was cancelled' } : null;
}

export async function prepareStagingRoot(nodesRoot: string): Promise<string> {
  const stagingRoot = stagingRootPath(nodesRoot);
  await registerNodeDependencies.mkdir(nodesRoot, { recursive: true });
  await registerNodeDependencies.rm(stagingRoot, { recursive: true, force: true });
  // Removes per-chat authoring dirs left behind by the retired env-var authoring flow.
  await registerNodeDependencies.rm(join(nodesRoot, '.authoring'), {
    recursive: true,
    force: true,
  });
  await registerNodeDependencies.mkdir(stagingRoot);
  const sessionRoot = join(stagingRoot, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  await registerNodeDependencies.mkdir(sessionRoot);
  return sessionRoot;
}
