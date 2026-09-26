// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuickCommentInput } from './quick-comment-input';

describe('QuickCommentInput', () => {
  it('keeps the fade animation on the glass element, not a portal ancestor', () => {
    render(
      <QuickCommentInput
        selectedText="const answer = 42;"
        source={{ type: 'diff', filePath: 'src/answer.ts', lineNumber: 3 }}
        rect={new DOMRect(100, 200, 80, 16)}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const glass = document.body.querySelector('.glass-lit');
    if (!glass) throw new Error('glass element not found');

    // The blur lives on the glass element; an ancestor fading it out of opacity
    // would make that ancestor a backdrop-filter root and hide the blur.
    expect(glass.classList.contains('animate-in')).toBe(true);
    expect(glass.parentElement?.closest('[class*="animate-in"],[class*="fade-in"]')).toBeNull();
  });
});
