import { useAtomValue } from 'jotai';
import { lazy, type ReactElement, Suspense, useContext } from 'react';
import { MainPaneInsetContext } from '@/components/SidebarMainPaneLayout';
import { agentsSettingsDialogOpenAtom } from '@/lib/atoms';
import { themeEditorSessionAtom } from '@/lib/themes/editor/editor-atoms';
import { DOCK_WIDTH_CLASS, useDockGlide } from '@/lib/themes/editor/use-theme-editor-dock';
import { cn } from '@/lib/utils';

const ThemeEditorPanel = lazy(() =>
  import('./Panel').then((module) => ({ default: module.ThemeEditorPanel })),
);

/** The workspace's right dock for an open editor session, so the panes beside it preview live. It
 * hides, not unmounts, under Settings to keep the draft; the panel's code loads on first open. */
export function ThemeEditorHost(): ReactElement {
  const session = useAtomValue(themeEditorSessionAtom);
  const settingsOpen = useAtomValue(agentsSettingsDialogOpenAtom);
  const inset = useContext(MainPaneInsetContext);
  const dock = useDockGlide(session !== null);
  return (
    <div
      ref={dock}
      data-theme-editor-dock=""
      hidden={settingsOpen}
      className={cn(
        'flex shrink-0 justify-end overflow-hidden',
        session ? DOCK_WIDTH_CLASS : 'w-0',
        // Closed, it takes back the inset row's gap, so the main pane still meets the window edge.
        !session && inset && '-ml-1',
      )}
    >
      {session ? (
        <Suspense fallback={null}>
          {/* A new session reseeds the draft rather than inheriting the last one. */}
          <ThemeEditorPanel key={session.seed.id} session={session} />
        </Suspense>
      ) : null}
    </div>
  );
}
