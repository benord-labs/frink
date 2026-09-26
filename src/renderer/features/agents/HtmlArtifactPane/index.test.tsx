// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HtmlArtifactData } from '../../../../shared/types/artifacts/html-artifact';
import { HtmlArtifactPaneProvider, useHtmlArtifactPane } from '.';

const FIRST: HtmlArtifactData = {
  version: 1,
  artifactId: 'first',
  title: 'First artifact',
  bodyHtml: '<p>First</p>',
};
const SECOND: HtmlArtifactData = {
  version: 1,
  artifactId: 'second',
  title: 'Second artifact',
  bodyHtml: '<p>Second</p>',
};

function PaneControls({ name }: { name: string }) {
  const { openArtifact, closeArtifact, selection } = useHtmlArtifactPane();
  return (
    <>
      <button type="button" data-html-artifact-trigger="first" onClick={() => openArtifact(FIRST)}>
        Open first {name}
      </button>
      <button
        type="button"
        data-html-artifact-trigger="second"
        onClick={() => openArtifact(SECOND)}
      >
        Open second {name}
      </button>
      <button type="button" onClick={closeArtifact}>
        Close {name}
      </button>
      <output aria-label={`${name} selection`}>{selection?.artifactId ?? 'closed'}</output>
    </>
  );
}

describe('HtmlArtifactPaneProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('allows one expanded artifact per pane without coupling separate panes', () => {
    render(
      <>
        <HtmlArtifactPaneProvider paneKey="left" isPaneActive>
          <PaneControls name="left" />
        </HtmlArtifactPaneProvider>
        <HtmlArtifactPaneProvider paneKey="right" isPaneActive={false}>
          <PaneControls name="right" />
        </HtmlArtifactPaneProvider>
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open first left' }));
    expect(screen.getByRole('status', { name: 'left selection' })).toHaveTextContent('first');

    fireEvent.click(screen.getByRole('button', { name: 'Open second left' }));
    expect(screen.getByRole('status', { name: 'left selection' })).toHaveTextContent('second');
    expect(screen.getByRole('status', { name: 'right selection' })).toHaveTextContent('closed');
  });

  it('restores focus to the trigger for the artifact that was collapsed', async () => {
    render(
      <HtmlArtifactPaneProvider paneKey="left" isPaneActive>
        <PaneControls name="left" />
      </HtmlArtifactPaneProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open second left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close left' }));
    await Promise.resolve();

    expect(screen.getByRole('button', { name: 'Open second left' })).toHaveFocus();
  });
});
