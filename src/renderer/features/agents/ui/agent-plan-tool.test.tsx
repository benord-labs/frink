// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { AgentPlanTool } from './agent-plan-tool';

describe('AgentPlanTool', () => {
  beforeEach(() => {
    cleanup();
  });

  it('keeps awaiting-approval plans expanded and shows the plan exactly as written', () => {
    render(
      <AgentPlanTool
        part={{
          type: 'tool-PlanWrite',
          toolCallId: 'plan-1',
          state: 'output-available',
          input: {
            action: 'create',
            plan: {
              id: 'plan-1',
              title: 'Plan ready',
              summary: 'Summary text',
              planText: `---
name: fix
---

## Context
- Context bullet, not a todo`,
              status: 'awaiting_approval',
            },
          },
          output: { success: true },
        }}
        chatStatus="ready"
        subChatId="sub-123"
      />,
    );

    expect(screen.queryByRole('button', { name: 'Expand plan details' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plan details expanded' })).toBeDisabled();
    expect(screen.getByText('Context bullet, not a todo')).toBeInTheDocument();
    expect(screen.queryByText('name: fix')).not.toBeInTheDocument();
    // No invented step checklist or progress count competes with the plan itself.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByText(/Completed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve & Run Ctrl+Enter' })).toBeInTheDocument();
  });

  it('disables Approve & Run immediately after click', () => {
    render(
      <AgentPlanTool
        part={{
          type: 'tool-PlanWrite',
          toolCallId: 'plan-3',
          state: 'output-available',
          input: {
            action: 'create',
            plan: {
              id: 'plan-3',
              title: 'Plan ready',
              summary: 'Summary text',
              planText: '## Plan\nStep one',
              status: 'awaiting_approval',
            },
          },
          output: { success: true },
        }}
        chatStatus="ready"
        subChatId="sub-123"
      />,
    );

    const approveButton = screen.getByRole('button', { name: 'Approve & Run Ctrl+Enter' });
    expect(approveButton).toBeEnabled();

    fireEvent.click(approveButton);

    expect(approveButton).toBeDisabled();
  });

  it('keeps Approve & Run enabled while streaming when plan is awaiting approval', () => {
    render(
      <AgentPlanTool
        part={{
          type: 'tool-PlanWrite',
          toolCallId: 'plan-stream',
          state: 'output-available',
          input: {
            action: 'create',
            plan: {
              id: 'plan-stream',
              title: 'Plan ready',
              summary: 'Summary text',
              planText: '## Plan\nStep one',
              status: 'awaiting_approval',
            },
          },
          output: { success: true },
        }}
        chatStatus="streaming"
        subChatId="sub-123"
        isStreaming
      />,
    );

    expect(screen.getByRole('button', { name: 'Approve & Run Ctrl+Enter' })).toBeEnabled();
  });

  it('suppresses Approve & Run for a flow-driven plan (flow run panel owns approval)', () => {
    render(
      <AgentPlanTool
        part={{
          type: 'tool-PlanWrite',
          toolCallId: 'plan-flow',
          state: 'output-available',
          input: {
            action: 'create',
            plan: {
              id: 'plan-flow',
              title: 'Plan ready',
              summary: 'Summary text',
              planText: '## Plan\nStep one',
              status: 'awaiting_approval',
              flowDriven: true,
            },
          },
          output: { success: true },
        }}
        chatStatus="ready"
        subChatId="sub-123"
      />,
    );

    // Plan still renders (awaiting approval), but the in-chat Approve button is gone — approval
    // must happen in the flow run panel to avoid double execution.
    expect(screen.getByRole('button', { name: 'Plan details expanded' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Approve & Run Ctrl+Enter' }),
    ).not.toBeInTheDocument();
  });

  it('does not render awaiting-approval footer once plan status is approved', () => {
    render(
      <AgentPlanTool
        part={{
          type: 'tool-PlanWrite',
          toolCallId: 'plan-4',
          state: 'output-available',
          input: {
            action: 'approve',
            plan: {
              id: 'plan-4',
              title: 'Plan approved',
              summary: 'Summary text',
              planText: '## Plan\nStep one',
              status: 'approved',
            },
          },
          output: { success: true },
        }}
        chatStatus="ready"
        subChatId="sub-123"
      />,
    );

    expect(screen.queryByText('Awaiting your approval to proceed')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Approve & Run Ctrl+Enter' }),
    ).not.toBeInTheDocument();
  });
});
