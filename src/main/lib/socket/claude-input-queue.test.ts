import { describe, expect, it } from 'vitest';
import { buildClaudeUserMessage } from './claude-input-queue';

const IMG = { mediaType: 'image/png', base64Data: 'AAAA' };

describe('buildClaudeUserMessage', () => {
  it('normal agent turn → bare string content (parity with the pre-streaming string prompt)', () => {
    expect(buildClaudeUserMessage('do the thing', [], 'agent').message.content).toBe(
      'do the thing',
    );
  });

  it('plan mode (no images) → single text block array (streaming input needed for interrupt())', () => {
    expect(buildClaudeUserMessage('make a plan', [], 'plan').message.content).toEqual([
      { type: 'text', text: 'make a plan' },
    ]);
  });

  it.each([
    // SAFETY: an empty literal has no element type to infer; the annotation names the one the
    // other rows already carry.
    ['plan', [] as (typeof IMG)[]],
    ['plan', [IMG]],
    ['agent', [IMG]],
  ])('%s mode with %# attachment set keeps /compact dispatchable', (mode, images) => {
    // These turns ship ARRAY content, not a bare string. The provider reads its command input from
    // the LAST text block of an array (claude-code processUserInput.ts:337-341) and then requires
    // position 0, so /compact only survives if the text block is last and unprefixed.
    // SAFETY: this row's inputs force the array branch of buildClaudeUserMessage — plan mode, or
    // an image attachment — so content is never the bare-string form.
    const content = buildClaudeUserMessage('/compact', images, mode).message.content as Array<{
      type: string;
      text?: string;
    }>;
    const last = content[content.length - 1];
    expect(last.type).toBe('text');
    expect(last.text).toBe('/compact');
  });

  it('image + text → image block followed by a text block', () => {
    const content = buildClaudeUserMessage('describe it', [IMG], 'agent').message.content as Array<{
      type: string;
    }>;
    expect(content.map((b) => b.type)).toEqual(['image', 'text']);
  });

  it('image only (empty caption) → a single image block, no text block', () => {
    const content = buildClaudeUserMessage('   ', [IMG], 'agent').message.content as Array<{
      type: string;
    }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('image');
  });
});
