// @vitest-environment happy-dom
/**
 * flowRunDisplayStatus maps a paused run that is actually working to a live display status, and
 * FlowRunStatusIcon must animate the spinner for that derived 'running' (EC9 — a label-only fix
 * would leave a frozen spinner beside a "Running" label).
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FlowRunStatusIcon, shouldPollFlowAdmission, shouldShowPausedActions } from './index';

afterEach(cleanup);

describe('shouldShowPausedActions', () => {
  it('hides actions while a paused run is actively working', () => {
    expect(shouldShowPausedActions('paused', 'running')).toBe(false);
    expect(shouldShowPausedActions('paused', 'pending')).toBe(false);
  });

  it('shows actions when a paused run is parked for user action', () => {
    expect(shouldShowPausedActions('paused', 'plan_ready')).toBe(true);
    expect(shouldShowPausedActions('paused', 'needs_attention')).toBe(true);
  });

  it('shows actions for a paused run with no active task (failed/blocked/cloud)', () => {
    expect(shouldShowPausedActions('paused', null)).toBe(true);
    expect(shouldShowPausedActions('paused', undefined)).toBe(true);
  });

  it('shows actions for a paused run whose driving task is non-running (passthrough branch)', () => {
    // A present-but-not-running active_task_status (failed/completed) hits flowRunDisplayStatus's
    // final passthrough → 'paused', distinct from the null short-circuit. Only running/pending hides.
    expect(shouldShowPausedActions('paused', 'failed')).toBe(true);
    expect(shouldShowPausedActions('paused', 'completed')).toBe(true);
  });

  it('hides actions when the run is not paused', () => {
    expect(shouldShowPausedActions('running', 'running')).toBe(false);
    expect(shouldShowPausedActions('completed', null)).toBe(false);
  });

  it('hides recovery actions while a resume admission is queued', () => {
    expect(shouldShowPausedActions('paused', null, 'queued')).toBe(false);
  });
});

describe('shouldPollFlowAdmission', () => {
  it('polls queued work and terminal runs whose lease is still settling', () => {
    expect(shouldPollFlowAdmission('pending', 'queued')).toBe(true);
    expect(shouldPollFlowAdmission('cancelled', 'releasing')).toBe(true);
    expect(shouldPollFlowAdmission('failed', 'active')).toBe(true);
  });

  it('does not add admission polling for stable active or terminal runs', () => {
    expect(shouldPollFlowAdmission('running', 'active')).toBe(false);
    expect(shouldPollFlowAdmission('cancelled', null)).toBe(false);
  });
});

describe('FlowRunStatusIcon (EC9 — spinner state)', () => {
  it('spins for running, stays static for paused, and shows a clock for awaiting_input', () => {
    const { container, rerender } = render(<FlowRunStatusIcon status="running" labelled />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();

    rerender(<FlowRunStatusIcon status="paused" labelled />);
    expect(container.querySelector('.animate-spin')).toBeNull();

    rerender(<FlowRunStatusIcon status="awaiting_input" labelled />);
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(screen.getByLabelText('Run awaiting input')).toBeInTheDocument();
  });

  it('labels a queued run independently of pending engine state', () => {
    render(<FlowRunStatusIcon status="queued" labelled />);
    expect(screen.getByLabelText('Run queued')).toBeInTheDocument();
  });
});
