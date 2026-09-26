import { join } from 'node:path';

type ElectronAppPath = {
  readonly isPackaged: boolean;
  getAppPath(): string;
};

type ElectronResourceLocation = {
  readonly development: readonly string[];
  readonly packaged: readonly string[];
};

export function resolveElectronResourcePath(
  app: ElectronAppPath,
  location: ElectronResourceLocation,
): string {
  return app.isPackaged
    ? join(process.resourcesPath, ...location.packaged)
    : join(app.getAppPath(), ...location.development);
}

/** Build a lazy resource resolver so importing a consumer does not require Electron's app mock. */
export function createElectronResourcePathResolver(
  getApp: () => ElectronAppPath,
  location: ElectronResourceLocation,
): () => string {
  return () => resolveElectronResourcePath(getApp(), location);
}
