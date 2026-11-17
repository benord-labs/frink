import { describe, expect, it } from 'vitest';
import { getBlocksLogicGuideline } from './blocks-logic';

describe('getBlocksLogicGuideline', () => {
  // Agents read this to design loops: it must not promise an engine cap that does not exist.
  it('says loop limits are not enforced and that condition-only loops are rejected', () => {
    const text = getBlocksLogicGuideline();
    expect(text).toContain('the engine does not enforce it');
    expect(text).toContain('A loop made only of condition nodes is rejected at run time');
    expect(text).not.toContain('per-node iteration guard');
  });
});
