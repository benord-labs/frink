// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link } from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ProjectRootRow } from './index';

type RowProps = ComponentProps<typeof ProjectRootRow>;

function Harness({
  initial,
  onRemove,
  missing,
  badge = { label: 'Linked', icon: Link, tone: 'linked' },
}: {
  initial: boolean;
  onRemove?: () => void;
} & Partial<Pick<RowProps, 'missing' | 'badge'>>) {
  const [expanded, setExpanded] = useState(initial);
  return (
    <TooltipProvider>
      <ProjectRootRow
        name="api"
        path="/w/api"
        branch="feat"
        missing={missing}
        badge={badge}
        expanded={expanded}
        onExpandedChange={setExpanded}
        controlsId="api-files"
        remove={onRemove && { label: 'Unlink api', onRemove }}
      />
      <div id="api-files" hidden={!expanded} />
    </TooltipProvider>
  );
}

/** The row's own button, named by its project first. */
const disclosure = () => screen.getByRole('button', { name: /^api/ });

afterEach(() => {
  cleanup();
});

describe('ProjectRootRow', () => {
  it.each([
    ['Enter opens', false, '{Enter}', true],
    ['Space closes', true, ' ', false],
    ['Right opens', false, '{ArrowRight}', true],
    ['Right keeps an open row open', true, '{ArrowRight}', true],
    ['Left closes', true, '{ArrowLeft}', false],
    ['Left keeps a closed row closed', false, '{ArrowLeft}', false],
  ])('%s', async (_, initial, key, expected) => {
    const user = userEvent.setup();
    render(<Harness initial={initial} />);
    disclosure().focus();

    await user.keyboard(key);

    expect(disclosure()).toHaveAttribute('aria-expanded', String(expected));
    expect(disclosure()).toHaveAttribute('aria-controls', 'api-files');
  });

  it('puts the x beside the row as its own stop, which removes without toggling', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<Harness initial={false} onRemove={onRemove} />);
    disclosure().focus();

    await user.tab();
    const remove = screen.getByRole('button', { name: 'Unlink api' });
    expect(remove).toHaveFocus();
    expect(disclosure()).not.toContainElement(remove);

    await user.keyboard('{Enter}');
    expect(onRemove).toHaveBeenCalledOnce();
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
  });

  it('has no x without a remove action', () => {
    render(<Harness initial={false} />);

    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('names the badge and branch in words inside the row, badge first', () => {
    render(<Harness initial={false} />);

    expect(disclosure()).toContainElement(screen.getByText('Linked'));
    expect(disclosure()).toContainElement(screen.getByText('feat'));
    expect(disclosure()).toHaveAccessibleName('api Linked on branch feat');
  });

  // happy-dom has no layout, so these pin the classes that order what gives way.
  it('lets the branch give way first, down to its icon, so the name keeps its room', () => {
    render(<Harness initial={false} />);

    // A shrink weighting alone still takes a fraction of a pixel from the name: enough for an ellipsis
    expect(screen.getByText('feat').parentElement).toHaveClass('grow', 'basis-0', 'min-w-3');
    expect(disclosure().parentElement).toHaveClass('@container/root-row');
  });

  it.each([
    ['Linked, with an icon, shrinks to it', undefined, true],
    ['Main, with no icon, keeps its label', { label: 'Main' }, false],
  ])('in a narrow row the badge %s', (_, badge, iconOnly) => {
    render(<Harness initial={false} badge={badge} />);

    const label = screen.getByText(badge?.label ?? 'Linked');
    expect(label.classList.contains('@max-[15rem]/root-row:sr-only')).toBe(iconOnly);
  });

  it.each([
    ['its name, badge and branch first', false, /^api · LinkedOn branch feat\/w\/api$/],
    [
      'its name and badge, and no branch for a missing folder',
      true,
      /^api · LinkedCan't find api's folder\.\/w\/api$/,
    ],
  ])('says %s in its tooltip', (_, missing, text) => {
    render(<Harness initial={false} missing={missing} />);

    fireEvent.focus(disclosure());

    expect(screen.getByRole('tooltip')).toHaveTextContent(text);
  });
});
