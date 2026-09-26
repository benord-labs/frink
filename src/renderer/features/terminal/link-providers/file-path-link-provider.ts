import type { IBufferLine, ILink, ILinkProvider, Terminal as XTerm } from 'xterm';
import { isModifierPressed, removeLinkPopup, showLinkPopup } from './link-popup';

/**
 * File path link provider for xterm.js.
 * Detects file paths with optional line and column numbers and makes them clickable.
 * Requires Cmd+Click (Mac) or Ctrl+Click (Windows/Linux) to activate.
 *
 * Supported formats:
 * - /absolute/path/to/file.ts
 * - /absolute/path/to/file.ts:10
 * - /absolute/path/to/file.ts:10:5
 * - ./relative/path/file.ts
 * - ./relative/path/file.ts:10:5
 * - ../parent/path/file.ts:10
 */

// Pattern for file paths with optional line:column
// Matches:
// - Absolute paths starting with /
// - Relative paths starting with ./ or ../
// - Optionally followed by :line or :line:column
const FILE_PATH_PATTERN =
  /(?:^|[\s'"({[])((?:\.\.?\/|\/)[^\s:'")\]}>]+?)(?::(\d+))?(?::(\d+))?(?=[\s'")\]}>]|$)/g;

// Pattern for checking file extensions
const FILE_EXTENSION_PATTERN = /\.[a-zA-Z0-9]+$/;

/**
 * Get the text content of a buffer line.
 */
function getLineText(line: IBufferLine): string {
  let text = '';
  for (let i = 0; i < line.length; i++) {
    text += line.getCell(i)?.getChars() || ' ';
  }
  return text;
}

/**
 * Check if a path looks like a file (has an extension or is a dotfile).
 */
function looksLikeFile(path: string): boolean {
  const basename = path.split('/').pop() || '';

  // Has an extension
  if (FILE_EXTENSION_PATTERN.test(basename)) {
    return true;
  }

  // Is a dotfile
  if (basename.startsWith('.') && basename.length > 1) {
    return true;
  }

  // Common extensionless files
  const extensionlessFiles = [
    'Makefile',
    'Dockerfile',
    'Vagrantfile',
    'Gemfile',
    'Rakefile',
    'LICENSE',
    'README',
    'CHANGELOG',
    'AUTHORS',
    'CONTRIBUTING',
  ];

  if (extensionlessFiles.includes(basename)) {
    return true;
  }

  return false;
}

export class FilePathLinkProvider implements ILinkProvider {
  constructor(
    private xterm: XTerm,
    private onClick: (event: MouseEvent, path: string, line?: number, column?: number) => void,
  ) {}

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const buffer = this.xterm.buffer.active;
    const line = buffer.getLine(bufferLineNumber);

    if (!line) {
      callback(undefined);
      return;
    }

    const lineText = getLineText(line);
    const links: ILink[] = [];

    FILE_PATH_PATTERN.lastIndex = 0;

    for (
      let match = FILE_PATH_PATTERN.exec(lineText);
      match !== null;
      match = FILE_PATH_PATTERN.exec(lineText)
    ) {
      const fullMatch = match[0];
      const path = match[1];
      const lineNum = match[2] ? Number.parseInt(match[2], 10) : undefined;
      const colNum = match[3] ? Number.parseInt(match[3], 10) : undefined;

      if (!looksLikeFile(path)) {
        continue;
      }

      const leadingChars =
        fullMatch.length -
        path.length -
        (match[2] ? match[2].length + 1 : 0) -
        (match[3] ? match[3].length + 1 : 0);
      const startX = match.index + leadingChars;

      let linkText = path;
      if (lineNum !== undefined) {
        linkText += `:${lineNum}`;
        if (colNum !== undefined) {
          linkText += `:${colNum}`;
        }
      }

      const endX = startX + linkText.length;

      links.push({
        range: {
          start: { x: startX + 1, y: bufferLineNumber + 1 },
          end: { x: endX + 1, y: bufferLineNumber + 1 },
        },
        text: linkText,
        decorations: {
          pointerCursor: true,
          underline: true,
        },
        activate: (event: MouseEvent) => {
          if (isModifierPressed(event)) {
            this.onClick(event, path, lineNum, colNum);
          }
        },
        hover: (event: MouseEvent, text: string) => {
          showLinkPopup(event, text);
        },
        leave: () => {
          removeLinkPopup();
        },
      });
    }

    callback(links.length > 0 ? links : undefined);
  }
}
