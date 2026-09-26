/**
 * Renderer entry point for slash-command expansion. Implementation lives in
 * src/shared/commands/ so the Electron main process (flows MCP command
 * expansion) can reuse it. Re-exported so renderer call sites keep their path.
 */
export {
  expandSlashCommand,
  isCompactCommand,
} from '../../../shared/commands/expand-slash-command';
