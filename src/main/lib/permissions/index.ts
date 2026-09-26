/**
 * Permissions module — public API.
 *
 * `src/main` follows the module-as-folder convention (every folder exposes its public
 * surface through `index.ts`; implementation lives in kebab-case siblings). Callers
 * should import the helpers below from `../permissions` rather than reaching into files.
 */
export { isPathWithinProject } from './path-check';
export {
  extractFilePathFromToolInput,
  getOperationFromToolName,
  isClaudePermissionGatedTool,
  remapPathForPermissionBoundary,
  resolvePermissionProjectPath,
  resolveToolPermissionPath,
} from './tool-validation';
