// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LAUNCH_FLAGS } from '../../../../shared/launch-flags';
import type { HtmlArtifactData } from '../../../../shared/types/artifacts/html-artifact';
import { HtmlArtifactPaneProvider } from '../HtmlArtifactPane';
import { HtmlArtifactCard } from '.';

const ARTIFACT: HtmlArtifactData = {
  version: 1,
  artifactId: 'message-digest',
  title: 'Customer message digest',
  bodyHtml: '<script>window.bad = true</script><h1>Customer message digest</h1>',
};

afterEach(() => {
  cleanup();
});

describe('HtmlArtifactCard', () => {
  it('keeps artifact HTML inert until the user runs it inline', () => {
    const { container } = render(
      <HtmlArtifactPaneProvider paneKey="chat-1:single" isPaneActive>
        <HtmlArtifactCard artifact={ARTIFACT} />
      </HtmlArtifactPaneProvider>,
    );

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('script')).toBeNull();

    if (!LAUNCH_FLAGS.flowHtmlArtifacts) {
      // Switched off, the delivered result still reads as content rather than a
      // blank gap — it just has no way to run.
      expect(screen.getByText(/Customer message digest/)).toBeInTheDocument();
      expect(screen.getByText(/turned off/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Run artifact' })).toBeNull();
      return;
    }

    expect(screen.getByText('Interactive result')).toBeInTheDocument();
    expect(screen.getByText(ARTIFACT.title)).toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: 'Run artifact' });
    expect(trigger).toHaveAttribute('data-html-artifact-trigger', ARTIFACT.artifactId);
  });
});
