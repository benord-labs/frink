// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentWebFetchTool } from './agent-web-fetch-tool';

const part = {
  type: 'tool-WebFetch',
  toolCallId: 'fetch-1',
  input: { url: 'https://www.example.com/a' },
};

describe('AgentWebFetchTool', () => {
  afterEach(cleanup);

  it('shows a fetch in progress as a row that cannot expand', () => {
    render(
      <AgentWebFetchTool part={{ ...part, state: 'input-available' }} chatStatus="streaming" />,
    );

    expect(screen.getByText('Fetching')).toBeInTheDocument();
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the size of a finished fetch and expands to its content', () => {
    render(
      <AgentWebFetchTool
        part={{
          ...part,
          state: 'output-available',
          output: { result: 'page body', bytes: 2048, code: 200 },
        }}
        chatStatus="ready"
      />,
    );

    expect(screen.getByText('Fetched')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.queryByText('page body')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('page body')).toBeInTheDocument();
  });

  it('names the status code of a failed fetch in place of a size', () => {
    render(
      <AgentWebFetchTool
        part={{ ...part, state: 'output-available', output: { result: '', bytes: 0, code: 404 } }}
        chatStatus="ready"
      />,
    );

    expect(screen.getByText('Error 404')).toBeInTheDocument();
    expect(screen.queryByText('0 B')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
