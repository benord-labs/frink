// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlowReplyBox } from './index';

// The three surfaces (running strip, paused bar, park answer) drive this box through different prop
// combinations. These cover the COMPONENT'S OWN contract — the props matrix each surface relies on.
// Surface-level behaviour lives in flow-run-strip.test.tsx / park-answer-surface.test.tsx.
describe('FlowReplyBox', () => {
  afterEach(cleanup);

  it('renders the summary as the ask, and omits the line entirely when there is none', () => {
    const { unmount } = render(
      <FlowReplyBox summary="how should I verify?" onSubmit={() => true} />,
    );
    expect(screen.getByText('how should I verify?')).toBeInTheDocument();
    unmount();

    render(<FlowReplyBox onSubmit={() => true} />);
    expect(screen.queryByText('how should I verify?')).toBeNull();
  });

  it('submits on Enter and clears, but keeps the text when the send is refused', () => {
    const sent = vi.fn(() => true);
    const { unmount } = render(<FlowReplyBox onSubmit={sent} />);
    const ok = screen.getByLabelText('Reply to the agent');
    fireEvent.change(ok, { target: { value: 'go with B' } });
    fireEvent.keyDown(ok, { key: 'Enter' });
    expect(sent).toHaveBeenCalledWith('go with B');
    expect(ok).toHaveValue('');
    unmount();

    render(<FlowReplyBox onSubmit={vi.fn(() => false)} />);
    const refused = screen.getByLabelText('Reply to the agent');
    fireEvent.change(refused, { target: { value: 'retry me' } });
    fireEvent.keyDown(refused, { key: 'Enter' });
    expect(refused).toHaveValue('retry me');
  });

  it('trims the submitted text and refuses whitespace-only input', () => {
    const onSubmit = vi.fn(() => true);
    render(<FlowReplyBox onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Reply to the agent');

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '  padded  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('padded');
  });

  it('never submits mid-IME-composition, so a half-composed reply cannot be sent', () => {
    const onSubmit = vi.fn(() => true);
    render(<FlowReplyBox onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Reply to the agent');
    fireEvent.change(input, { target: { value: 'にほんご' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('offers the labelled Reply button by default and the queue control on submit="queue"', () => {
    const { unmount } = render(<FlowReplyBox onSubmit={() => true} />);
    expect(screen.getByText('Reply')).toBeInTheDocument();
    expect(screen.queryByLabelText('Add to queue')).toBeNull();
    unmount();

    // The strip's note rides the message QUEUE, so it borrows the composer's wording rather than
    // claiming a send the caller does not perform.
    render(<FlowReplyBox submit="queue" onSubmit={() => true} />);
    expect(screen.getByLabelText('Add to queue')).toBeInTheDocument();
    expect(screen.queryByText('Reply')).toBeNull();
  });

  it('disables the submit control until there is something to send', () => {
    render(<FlowReplyBox onSubmit={() => true} />);
    expect(screen.getByText('Reply')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reply to the agent'), { target: { value: 'x' } });
    expect(screen.getByText('Reply')).toBeEnabled();
  });

  it('lifts its text when controlled, and owns it otherwise', () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <FlowReplyBox value="from the caller" onChange={onChange} onSubmit={() => true} />,
    );
    const controlled = screen.getByLabelText('Reply to the agent');
    expect(controlled).toHaveValue('from the caller');
    // A controlled box reports upward instead of mutating local state.
    fireEvent.change(controlled, { target: { value: 'typed' } });
    expect(onChange).toHaveBeenCalledWith('typed');
    expect(controlled).toHaveValue('from the caller');
    unmount();

    render(<FlowReplyBox onSubmit={() => true} />);
    const uncontrolled = screen.getByLabelText('Reply to the agent');
    fireEvent.change(uncontrolled, { target: { value: 'typed' } });
    expect(uncontrolled).toHaveValue('typed');
  });

  it('reports Escape to the caller only when it asked to handle it', () => {
    const onCancel = vi.fn();
    render(<FlowReplyBox onCancel={onCancel} onSubmit={() => true} />);
    fireEvent.keyDown(screen.getByLabelText('Reply to the agent'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('drops the composer shell when bare, so a caller that owns a card gets no card-in-card', () => {
    const { container, unmount } = render(<FlowReplyBox onSubmit={() => true} />);
    const shelled = container.querySelector('.chat-composer-glass');
    expect(shelled).not.toBeNull();
    unmount();

    const bare = render(<FlowReplyBox bare onSubmit={() => true} />);
    expect(bare.container.querySelector('.chat-composer-glass')).toBeNull();
    expect(bare.container.querySelector('input')).not.toBeNull();
  });
});
