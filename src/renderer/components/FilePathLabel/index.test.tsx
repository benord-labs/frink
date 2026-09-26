// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FilePathLabel } from './index';

describe('FilePathLabel', () => {
  it('renders the directory as a prefix with a trailing separator', () => {
    render(<FilePathLabel dirPath="src/renderer/features" fileName="index.tsx" />);

    expect(screen.getByText('src/renderer/features/')).toBeTruthy();
    expect(screen.getByText('index.tsx')).toBeTruthy();
  });

  it('omits the directory element entirely for a repo-root file', () => {
    // getFileDir returns '' for a path with no separator, and an empty prefix must not
    // render a bare "/" in front of the filename.
    const { container } = render(<FilePathLabel dirPath="" fileName="README.md" />);

    expect(screen.getByText('README.md')).toBeTruthy();
    expect(container.textContent).toBe('README.md');
  });
});
