import { describe, expect, it } from 'vitest';
import {
  isCustomNodeBlockType,
  isRegisteredBlockType,
  V1_FLOW_BLOCK_DEFINITIONS,
} from './block-registry';

describe('isCustomNodeBlockType', () => {
  it('returns true for typical custom node names', () => {
    expect(isCustomNodeBlockType('check-new-prs')).toBe(true);
    expect(isCustomNodeBlockType('my-node')).toBe(true);
    expect(isCustomNodeBlockType('send-slack-message')).toBe(true);
  });

  it('returns true for names with underscores', () => {
    expect(isCustomNodeBlockType('my_node')).toBe(true);
    expect(isCustomNodeBlockType('send_email')).toBe(true);
  });

  it('returns true for names starting with a digit', () => {
    expect(isCustomNodeBlockType('1node')).toBe(true);
    expect(isCustomNodeBlockType('42task')).toBe(true);
  });

  it('returns true for a single lowercase character', () => {
    expect(isCustomNodeBlockType('a')).toBe(true);
  });

  it('returns false for first-party block types', () => {
    expect(isCustomNodeBlockType('start_task')).toBe(false);
    expect(isCustomNodeBlockType('manual_trigger')).toBe(false);
    expect(isCustomNodeBlockType('condition')).toBe(false);
    expect(isCustomNodeBlockType('fan_out')).toBe(false);
    expect(isCustomNodeBlockType('run_command')).toBe(false);
    expect(isCustomNodeBlockType('http_request')).toBe(false);
  });

  it('returns false for names with uppercase letters', () => {
    expect(isCustomNodeBlockType('MyNode')).toBe(false);
    expect(isCustomNodeBlockType('CHECK-NEW-PRS')).toBe(false);
    expect(isCustomNodeBlockType('INVALID')).toBe(false);
  });

  it('returns false for names starting with a hyphen', () => {
    expect(isCustomNodeBlockType('-bad-name')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isCustomNodeBlockType('')).toBe(false);
  });

  it('returns false for names with spaces', () => {
    expect(isCustomNodeBlockType('has space')).toBe(false);
    expect(isCustomNodeBlockType('invalid type')).toBe(false);
  });

  it('returns false for names with special characters outside [-_]', () => {
    expect(isCustomNodeBlockType('node.js')).toBe(false);
    expect(isCustomNodeBlockType('node@1')).toBe(false);
    expect(isCustomNodeBlockType('node/path')).toBe(false);
  });

  it('is complementary to isRegisteredBlockType for first-party types', () => {
    const firstPartyTypes = V1_FLOW_BLOCK_DEFINITIONS.map((d) => d.type);
    for (const t of firstPartyTypes) {
      expect(isRegisteredBlockType(t)).toBe(true);
      expect(isCustomNodeBlockType(t)).toBe(false);
    }
  });
});
