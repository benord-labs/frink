import { join, resolve } from 'node:path';
import { frinkUserHome } from './platform/frink-home';

/** Resolved absolute path to ~/.frink/nodes/ (flow custom node scripts + manifests); the QA rig points it at its own profile. */
export const FRINK_CUSTOM_NODES_DIR = resolve(
  process.env.FRINK_CUSTOM_NODES_DIR ?? join(frinkUserHome(), '.frink', 'nodes'),
);
