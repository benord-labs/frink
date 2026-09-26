// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const snap = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string; path: string }>,
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    projects: {
      list: { useQuery: () => ({ data: snap.projects }) },
    },
  },
}));

// ProjectSelector pulls the full agents feature; the field only needs a picker stub.
vi.mock('../../../../agents/ProjectSelector', () => ({
  ProjectSelector: () => <button type="button">picker</button>,
}));

import { TooltipProvider } from '../../../../../components/ui/tooltip';
import { NodeProjectField } from './index';

// The mode toggle is Tooltip-wrapped; App.tsx provides the provider in production.
const render = (ui: React.ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

describe('NodeProjectField', () => {
  afterEach(() => {
    cleanup();
    snap.projects = [];
  });

  it('shows the flow-default CTA only when nothing is picked and nothing is inherited', () => {
    const onOpen = vi.fn();
    render(
      <NodeProjectField
        projectId=""
        flowDefaultProjectId={undefined}
        onProjectIdChange={() => {}}
        onOpenFlowSettings={onOpen}
      />,
    );
    const cta = screen.getByRole('button', { name: 'Or set a flow default project' });
    fireEvent.click(cta);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('hides the CTA when a flow default is inherited and shows the project name', () => {
    snap.projects = [{ id: 'p1', name: 'Frink', path: '/repo' }];
    render(
      <NodeProjectField
        projectId=""
        flowDefaultProjectId="p1"
        onProjectIdChange={() => {}}
        onOpenFlowSettings={() => {}}
      />,
    );
    expect(screen.queryByText('Or set a flow default project')).not.toBeInTheDocument();
    expect(screen.getByText('Frink')).toBeInTheDocument();
    expect(screen.getByText('inherited')).toBeInTheDocument();
  });

  it('falls back to a truncated id label when the inherited project is unknown', () => {
    render(
      <NodeProjectField
        projectId=""
        flowDefaultProjectId="0123456789abcdef"
        onProjectIdChange={() => {}}
      />,
    );
    expect(screen.getByText('01234567…')).toBeInTheDocument();
  });

  it('hides the CTA when the node has its own override', () => {
    snap.projects = [{ id: 'p2', name: 'Other', path: '/other' }];
    render(
      <NodeProjectField
        projectId="p2"
        flowDefaultProjectId={undefined}
        onProjectIdChange={() => {}}
        onOpenFlowSettings={() => {}}
      />,
    );
    expect(screen.queryByText('Or set a flow default project')).not.toBeInTheDocument();
  });

  it('omits the CTA entirely without an onOpenFlowSettings handler', () => {
    render(
      <NodeProjectField
        projectId=""
        flowDefaultProjectId={undefined}
        onProjectIdChange={() => {}}
      />,
    );
    expect(screen.queryByText('Or set a flow default project')).not.toBeInTheDocument();
  });

  // A non-propagating spy would hide mode bugs — the component derives expression mode from the
  // value it is given, so the value has to actually round-trip.
  function ControlledHost({ initial, onChange }: { initial: string; onChange: (v: string) => void }) {
    const [value, setValue] = useState(initial);
    return (
      <NodeProjectField
        projectId={value}
        flowDefaultProjectId="flow-pid"
        onProjectIdChange={(v) => {
          setValue(v);
          onChange(v);
        }}
      />
    );
  }

  it('shows a variable input instead of the picker when the value holds a template', () => {
    render(<ControlledHost initial="{{trigger.project}}" onChange={() => {}} />);

    expect(screen.getByLabelText('Project variable')).toHaveValue('{{trigger.project}}');
    expect(screen.queryByRole('button', { name: 'picker' })).not.toBeInTheDocument();
  });

  it('keeps the picked project when toggling to a variable and back', () => {
    render(<ControlledHost initial="proj-1" onChange={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Use a variable' }));
    expect(screen.getByLabelText('Project variable')).toHaveValue('proj-1');

    fireEvent.click(screen.getByRole('button', { name: 'Use a fixed value' }));
    expect(screen.getByRole('button', { name: 'picker' })).toBeInTheDocument();
  });


  it("abandons a variable by emitting '' — the value that means 'inherit', never undefined", () => {
    const onChange = vi.fn();
    render(<ControlledHost initial="{{trigger.project}}" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Use a fixed value' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('keeps the input mounted while a template is half-typed', () => {
    render(<ControlledHost initial="proj-1" onChange={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Use a variable' }));
    fireEvent.change(screen.getByLabelText('Project variable'), { target: { value: '{{tri' } });
    expect(screen.getByLabelText('Project variable')).toHaveValue('{{tri');
  });

  it("discards a half-typed template on abandon rather than leaving it in the config", () => {
    const onChange = vi.fn();
    render(<ControlledHost initial="proj-1" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Use a variable' }));
    fireEvent.change(screen.getByLabelText('Project variable'), { target: { value: '{{tri' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use a fixed value' }));
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('reopens a saved half-typed template in variable mode, not as a picker override', () => {
    // Leaving the panel mid-edit persists `{{tri`. Mount and abandon must agree on what counts
    // as template-shaped, or the value comes back as a project override showing a garbage name.
    render(<ControlledHost initial="{{tri" onChange={() => {}} />);

    expect(screen.getByLabelText('Project variable')).toHaveValue('{{tri');
    expect(screen.queryByRole('button', { name: 'picker' })).not.toBeInTheDocument();
  });

  it('returns to the picker after Reset to flow default, not a stuck variable input', () => {
    render(<ControlledHost initial="{{trigger.project}}" onChange={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reset to flow default' }));
    fireEvent.click(screen.getByRole('button', { name: /override/i }));

    expect(screen.getByRole('button', { name: 'picker' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Project variable')).not.toBeInTheDocument();
  });

  it('offers no variable toggle when the block reads projectId statically', () => {
    rtlRender(
      <TooltipProvider>
        <NodeProjectField
          projectId="proj-1"
          flowDefaultProjectId="flow-pid"
          onProjectIdChange={() => {}}
          allowTemplate={false}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Use a variable' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'picker' })).toBeInTheDocument();
  });
});
