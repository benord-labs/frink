import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { frinkUserHome } from '../../../platform/frink-home';
import {
  discoverCustomNodes,
  invalidateCustomNodesDiscoveryCache,
} from '../../../custom-nodes/discovery';
import { runCustomNodeScript } from '../../../custom-nodes/script-runner';
import { replaceDirectory } from '../../../platform';
import { captureMainException } from '../../../sentry/init';
import {
  readBoundedInstalledFile,
  readInstalledPackageState,
} from './package';
import { stageRegistrationPackage } from './package-registration';
import { readExistingRegisteredNode } from './register-node-support';
import { rehashPackageDirectory, stagePackageDirectory } from './resource-files';

/** Runtime service seam; tests spy on this plain object without replacing ESM modules. */
export const registerNodeDependencies = {
  captureMainException,
  discoverCustomNodes,
  frinkUserHome,
  homedir,
  invalidateCustomNodesDiscoveryCache,
  mkdir,
  readBoundedInstalledFile,
  readExistingRegisteredNode,
  readInstalledPackageState,
  rehashPackageDirectory,
  replaceDirectory,
  rm,
  runCustomNodeScript,
  stagePackageDirectory,
  stageRegistrationPackage,
  writeFile,
};
