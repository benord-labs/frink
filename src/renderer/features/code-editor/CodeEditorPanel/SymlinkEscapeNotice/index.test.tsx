// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { UseSymlinkEscapeQuery } from '@/lib/code-editor/files/use-symlink-escape';
import { SymlinkEscapeNotice } from './index';

const escapingTo =
  (realPath: string): UseSymlinkEscapeQuery =>
  () => ({ data: { escapes: true, realPath } });
const notEscaping: UseSymlinkEscapeQuery = () => ({ data: { escapes: false } });

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SymlinkEscapeNotice', () => {
  it('names the real location and warns that saving changes it', () => {
    render(
      <SymlinkEscapeNotice
        useEscapeQuery={escapingTo('/Users/me/.bashrc')}
        projectPath="/repo"
        filePath="/repo/config.yml"
        projectName="demo"
        canSave
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'This file is a link to /Users/me/.bashrc, outside demo. Saving changes that file.',
    );
  });

  it('makes no claim about saving on a read-only tab', () => {
    render(
      <SymlinkEscapeNotice
        useEscapeQuery={escapingTo('/Users/me/logo.png')}
        projectPath="/repo"
        filePath="/repo/logo.png"
        projectName="demo"
        canSave={false}
      />,
    );

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('This file is a link to /Users/me/logo.png, outside demo.');
    expect(notice).not.toHaveTextContent('Saving');
  });

  it('shows nothing for a file that stays inside its project', () => {
    render(
      <SymlinkEscapeNotice
        useEscapeQuery={notEscaping}
        projectPath="/repo"
        filePath="/repo/src/a.ts"
        projectName="demo"
        canSave
      />,
    );

    expect(screen.queryByRole('status')).toBeNull();
  });
});
