import { app } from 'electron';
import { createElectronResourcePathResolver } from '../platform/electron-resource-path';

export const MANAGED_CUSTOM_NODE_BOOTSTRAP_RESOURCE = 'custom-nodes/managed-bootstrap.mjs';

export const getManagedCustomNodeBootstrapPath = createElectronResourcePathResolver(() => app, {
  development: ['resources', MANAGED_CUSTOM_NODE_BOOTSTRAP_RESOURCE],
  packaged: [MANAGED_CUSTOM_NODE_BOOTSTRAP_RESOURCE],
});
