// @vitest-environment happy-dom
/** The chips under the React Compiler, as the shipped renderer is: the row hands them the same
 *  props until its git controls first measure, which is when the chips must ask for room again. */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { LinkedProjectChips } from '.';

// One object for every render, as the tree's query gives a chat whose links have not changed.
const tree = vi.hoisted(() => ({
  extras: ['api', 'web'].map((id) => ({ id, name: id, path: `/w/${id}`, missing: false })),
  canAdd: true,
  remove: () => undefined,
}));
vi.mock('@/lib/workspace-context/use-tree-projects', () => ({ useTreeProjects: () => tree }));
vi.mock('@/components/ProjectPicker/LinkProjectPicker', () => ({
  LinkProjectPicker: ({ trigger }: { trigger: ReactNode }) => trigger,
}));
vi.mock('../../../../stores/message-store', () => ({ readLoadedChatTexts: () => [] }));

afterEach(cleanup);

it('steps down when the git controls first measure as crowded, with every other prop the same', () => {
  let crowdedNow = false;
  const crowded = () => crowdedNow;
  const chips = (hiddenCount: number) => (
    <TooltipProvider>
      <LinkedProjectChips chatId="c1" crowded={crowded} crowdKey="git" hiddenCount={hiddenCount} />
    </TooltipProvider>
  );
  const { rerender } = render(chips(0));
  expect(screen.getByRole('button', { name: 'Unlink api' })).toBeInTheDocument();

  crowdedNow = true;
  rerender(chips(1));

  expect(screen.queryByRole('button', { name: 'Unlink api' })).toBeNull();
  expect(screen.getByRole('button', { name: '+2 linked' })).toBeInTheDocument();
});
