// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TemplateHighlightContainer } from './TemplateHighlightContainer';

afterEach(() => {
  cleanup();
});

describe('TemplateHighlightContainer', () => {
  it('renders mirror marks for template placeholders', () => {
    const value = '{{previous.x}} tail';
    const { container } = render(
      <TemplateHighlightContainer value={value} nodeVariables={null}>
        <textarea aria-label="template" defaultValue={value} />
      </TemplateHighlightContainer>,
    );
    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBe(1);
    expect(marks[0]?.textContent).toBe('{{previous.x}}');
  });

  it('lists an advisory line when a placeholder is undeclared', () => {
    const value = '{{previous.missing}}';
    const { container } = render(
      <TemplateHighlightContainer
        value={value}
        nodeVariables={{
          previous: [],
          trigger: [],
          loop: null,
          flow: null,
          notes: [],
        }}
      >
        <textarea aria-label="template" defaultValue={value} />
      </TemplateHighlightContainer>,
    );
    const item = container.querySelector('.flow-template-var-msg--undeclared');
    expect(item).toBeTruthy();
    expect(screen.getByRole('list')).toBeTruthy();
    expect(item?.textContent).toContain('{{previous.missing}}');
  });
});
