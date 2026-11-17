// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentPastedTextItem } from './agent-pasted-text-item';

describe('AgentPastedTextItem', () => {
  afterEach(cleanup);

  it('shows an attached file by its name, with a remove control named after it', () => {
    render(
      <AgentPastedTextItem
        filePath="/s/pasted/1a2b3c4d-report.pdf"
        filename="1a2b3c4d-report.pdf"
        size={2048}
        preview="report.pdf"
        onRemove={() => {}}
      />,
    );

    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove report.pdf' })).toBeInTheDocument();
  });

  it('keeps showing pasted text by its opening line', () => {
    render(
      <AgentPastedTextItem
        filePath="/s/pasted/pasted_1.txt"
        filename="pasted_1.txt"
        size={6000}
        preview={'first line\nsecond'}
        onRemove={() => {}}
      />,
    );

    expect(screen.getByText('first line')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove pasted text' })).toBeInTheDocument();
  });
});
