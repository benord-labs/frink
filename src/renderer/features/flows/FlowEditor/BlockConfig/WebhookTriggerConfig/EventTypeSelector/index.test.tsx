// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EventTypeSelector } from './index';

const EVENTS = [{ id: 'story_assigned', label: 'Story assigned to me' }];

function renderSelector(eventType: string, eventTypes: typeof EVENTS | undefined = EVENTS) {
  render(
    <EventTypeSelector eventType={eventType} eventTypes={eventTypes} onEventTypeChange={vi.fn()} />,
  );
}

describe('EventTypeSelector', () => {
  it('names a stored event the provider no longer offers instead of showing a blank control', () => {
    renderSelector('story_deleted');

    expect(screen.getByText('story_deleted (no longer available)')).toBeInTheDocument();
  });

  it('shows the label of an event the provider still offers', () => {
    renderSelector('story_assigned');

    expect(screen.getByText('Story assigned to me')).toBeInTheDocument();
    expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument();
  });

  it('waits for the event list before calling a stored event removed', () => {
    renderSelector('story_assigned', undefined);

    expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument();
  });
});
