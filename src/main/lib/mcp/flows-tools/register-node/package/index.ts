/**
 * Public API of a custom-node package: its manifest, installed state and expected
 * state. `resource-files.ts` imports the submodules directly because they import it back.
 */
export { expectedPackageState } from './expected-package-state';
export {
  type InstalledPackageState,
  readBoundedInstalledFile,
  readInstalledPackageState,
} from './installed-package-state';
export { readPackageManifest } from './package-manifest';
