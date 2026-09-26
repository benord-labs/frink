/**
 * Renderer entry point for the [/cmd:name]...[/cmd-end] block format. Implementation lives in
 * src/shared/commands/ so expandSlashCommand can substitute $ARGUMENTS inside a block before send.
 */
export {
  CMD_BLOCK_MESSAGE_REGEX,
  CMD_BLOCK_SERIALIZE_REGEX,
  encodeCommandBlock,
} from '../../../shared/commands/command-block-format';
