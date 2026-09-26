// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DebugReproduceCard, parseSteps } from './debug-reproduce-card';

describe('parseSteps', () => {
  it('parses numbered steps and strips the number prefix', () => {
    const steps = parseSteps('1. Open the app\n2. Click debug\n3. Enter a message');
    expect(steps).toEqual([
      { number: 1, text: 'Open the app' },
      { number: 2, text: 'Click debug' },
      { number: 3, text: 'Enter a message' },
    ]);
  });

  it('parses steps with parenthesis numbering (1) style)', () => {
    const steps = parseSteps('1) Open app\n2) Click button');
    expect(steps).toEqual([
      { number: 1, text: 'Open app' },
      { number: 2, text: 'Click button' },
    ]);
  });

  it('auto-numbers non-numbered content lines', () => {
    const steps = parseSteps('Open the app\nClick the debug button\nType a message');
    expect(steps).toEqual([
      { number: 1, text: 'Open the app' },
      { number: 2, text: 'Click the debug button' },
      { number: 3, text: 'Type a message' },
    ]);
  });

  it('skips blank lines', () => {
    const steps = parseSteps('1. Step one\n\n\n2. Step two');
    expect(steps).toHaveLength(2);
  });

  it('returns empty array for empty string', () => {
    expect(parseSteps('')).toEqual([]);
  });
});

describe('DebugReproduceCard', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders numbered steps with header', () => {
    render(<DebugReproduceCard content={'1. Open the app\n2. Click debug'} />);

    expect(screen.getByText('Reproduction Steps')).toBeInTheDocument();
    expect(screen.getByText('Open the app')).toBeInTheDocument();
    expect(screen.getByText('Click debug')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders the verification prompt footer', () => {
    render(<DebugReproduceCard content={'1. Open the app'} />);
    expect(
      screen.getByText('Try these steps and let me know if the bug reproduces.'),
    ).toBeInTheDocument();
  });

  it('returns null for empty content', () => {
    const { container } = render(<DebugReproduceCard content="" />);
    expect(container.innerHTML).toBe('');
  });

  it('returns null for whitespace-only content', () => {
    const { container } = render(<DebugReproduceCard content={'   \n\n  '} />);
    expect(container.innerHTML).toBe('');
  });
});
