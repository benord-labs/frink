// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessagePart } from '../stores/message-store';
import { AgentToolCall } from './agent-tool-call';
import { AgentToolRegistry } from './agent-tool-registry';

const { TextShimmerMock } = vi.hoisted(() => {
  const fn = vi.fn(
    (props: { variant?: string; as?: string; children: ReactNode; className?: string }) => (
      <span data-testid="text-shimmer" data-variant={props.variant ?? ''}>
        {props.children}
      </span>
    ),
  );
  return { TextShimmerMock: fn };
});

vi.mock('../../../components/ui/text-shimmer', () => ({
  TextShimmer: (props: {
    variant?: string;
    as?: string;
    children: ReactNode;
    className?: string;
  }) => TextShimmerMock(props),
}));

vi.mock('../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

const MockIcon = (props: { className?: string }) => (
  <span data-testid="icon" className={props.className} />
);

describe('AgentToolCall', () => {
  it('passes titleShimmerVariant spectrum to TextShimmer when pending', () => {
    TextShimmerMock.mockClear();
    render(
      <AgentToolCall
        icon={MockIcon}
        title="Planning line"
        isPending
        isError={false}
        titleShimmerVariant="spectrum"
      />,
    );

    expect(screen.getByText('Planning line')).toBeInTheDocument();
    expect(TextShimmerMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'spectrum' }));
  });

  it('defaults title shimmer variant to default when omitted', () => {
    TextShimmerMock.mockClear();
    render(<AgentToolCall icon={MockIcon} title="Grepping" isPending isError={false} />);

    expect(TextShimmerMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'default' }));
  });

  it('does not use TextShimmer when not pending', () => {
    TextShimmerMock.mockClear();
    render(<AgentToolCall icon={MockIcon} title="Done" isPending={false} isError={false} />);

    expect(TextShimmerMock).not.toHaveBeenCalled();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });
});

describe('AgentToolRegistry tool-planning', () => {
  it('declares spectrum title shimmer for planning status', () => {
    expect(AgentToolRegistry['tool-planning'].titleShimmerVariant).toBe('spectrum');
  });
});

describe('AgentToolRegistry tool-planning title cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the same title when called again with the same synthetic toolCallId', () => {
    const part: MessagePart = {
      type: 'tool-planning',
      toolCallId: 'ui-streaming-planning:unit-sub:unit-msg-stable',
    };
    const title = AgentToolRegistry['tool-planning'].title;
    const first = title(part);
    expect(title(part)).toBe(first);
  });

  it('uses separate cache entries for distinct synthetic toolCallIds', () => {
    const randomSpy = vi.spyOn(Math, 'random');
    randomSpy.mockReturnValueOnce(0);
    randomSpy.mockReturnValueOnce(1 - Number.EPSILON);
    const title = AgentToolRegistry['tool-planning'].title;
    const keyA: MessagePart = {
      type: 'tool-planning',
      toolCallId: 'ui-streaming-planning:unit-sub:key-a',
    };
    const keyB: MessagePart = {
      type: 'tool-planning',
      toolCallId: 'ui-streaming-planning:unit-sub:key-b',
    };
    const lineA = title(keyA);
    const lineB = title(keyB);
    expect(lineA).not.toBe(lineB);
    expect(title(keyA)).toBe(lineA);
  });

  it('keeps one phrase across the user→assistant site handoff within a turn', () => {
    // One turn renders the pending card at two sites (group placeholder, then empty
    // assistant message); a mid-wait phrase swap at the handoff reads as a glitch.
    const title = AgentToolRegistry['tool-planning'].title;
    const userCard: MessagePart = {
      type: 'tool-planning',
      toolCallId: 'ui-streaming-planning:sub-handoff:user:u1',
    };
    const assistantCard: MessagePart = {
      type: 'tool-planning',
      toolCallId: 'ui-streaming-planning:sub-handoff:msg:a1',
    };
    const phrase = title(userCard);
    expect(title(assistantCard)).toBe(phrase);
  });

  it('gives a msg-tagged card a stable per-id phrase when no turn seeded the scope (reload mid-stream)', () => {
    // The user card never rendered, so the scope is unseeded; the assistant card must
    // still get a stable phrase without writing the scope (a stale seed would eat the
    // next turn's rotation).
    const randomSpy = vi.spyOn(Math, 'random');
    randomSpy.mockReturnValueOnce(0);
    randomSpy.mockReturnValueOnce(1 - Number.EPSILON);
    const title = AgentToolRegistry['tool-planning'].title;
    const orphanMsg: MessagePart = {
      type: 'tool-planning',
      toolCallId: 'ui-streaming-planning:sub-reload:msg:a1',
    };
    const phrase = title(orphanMsg);
    expect(title(orphanMsg)).toBe(phrase);
    // Next turn seeds the scope fresh — the msg miss must not have pre-seeded it.
    const nextTurn: MessagePart = {
      type: 'tool-planning',
      toolCallId: 'ui-streaming-planning:sub-reload:user:u1',
    };
    expect(title(nextTurn)).not.toBe(phrase);
  });

  it('rotates the phrase when a new user message starts a new turn', () => {
    const randomSpy = vi.spyOn(Math, 'random');
    randomSpy.mockReturnValueOnce(0);
    randomSpy.mockReturnValueOnce(1 - Number.EPSILON);
    const title = AgentToolRegistry['tool-planning'].title;
    const turn1: MessagePart = {
      type: 'tool-planning',
      toolCallId: 'ui-streaming-planning:sub-rotate:user:u1',
    };
    const turn2: MessagePart = {
      type: 'tool-planning',
      toolCallId: 'ui-streaming-planning:sub-rotate:user:u2',
    };
    expect(title(turn1)).not.toBe(title(turn2));
  });

  it('shares one cached line for all parts omitting toolCallId (__planning_default__)', () => {
    const title = AgentToolRegistry['tool-planning'].title;
    const noIdA: MessagePart = { type: 'tool-planning' };
    const noIdB: MessagePart = { type: 'tool-planning', state: 'input-streaming' };
    expect(title(noIdA)).toBe(title(noIdB));
    expect(title(noIdA)).toBe(title(noIdA));
  });
});
