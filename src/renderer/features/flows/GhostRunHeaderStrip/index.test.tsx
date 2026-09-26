// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'jotai';
import { afterEach, describe, expect, it } from 'vitest';
import { ghostRunHeaderStateAtom } from '../../../lib/flow-rehearsal';
import { appStore } from '../../../lib/jotai-store';
import { GhostRunHeaderStrip } from './index';

function renderStrip() {
  return render(
    <Provider store={appStore}>
      <GhostRunHeaderStrip />
    </Provider>,
  );
}

describe('GhostRunHeaderStrip', () => {
  afterEach(() => {
    cleanup();
    appStore.set(ghostRunHeaderStateAtom, null);
  });

  it('renders nothing when no rehearsal is active', () => {
    appStore.set(ghostRunHeaderStateAtom, null);
    renderStrip();
    expect(screen.queryByText('Rehearsal')).not.toBeInTheDocument();
  });

  it('shows the honest summary + a finding row (why + fix)', () => {
    appStore.set(ghostRunHeaderStateAtom, {
      findingCount: 1,
      affectedNodeCount: 1,
      errorCount: 1,
      nodeCount: 2,
      riskiestNodeId: 'n',
      riskiestNodeLabel: 'Run cmd',
      findings: [
        {
          nodeId: 'n',
          nodeLabel: 'Run cmd',
          severity: 'error',
          rule: 'run_command.missing_command',
          why: 'no command set',
          fix: 'add a command',
        },
      ],
    });
    renderStrip();
    expect(screen.getByText('1 issue across 1 step')).toBeInTheDocument();
    expect(screen.getByText('no command set')).toBeInTheDocument();
    expect(screen.getByText('Fix: add a command')).toBeInTheDocument();
  });

  it('shows the clean "looks ready" state with zero findings', () => {
    appStore.set(ghostRunHeaderStateAtom, {
      findingCount: 0,
      affectedNodeCount: 0,
      errorCount: 0,
      nodeCount: 3,
      riskiestNodeId: null,
      riskiestNodeLabel: '',
      findings: [],
    });
    renderStrip();
    expect(screen.getByText('No issues found — looks ready')).toBeInTheDocument();
  });
});
