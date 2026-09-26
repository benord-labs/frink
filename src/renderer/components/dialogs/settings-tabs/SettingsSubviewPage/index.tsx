/** One page for several tab ids: focus stays on the tabs, each panel mounts fresh on switch,
 * and the tabs write the settings tab atom so deep links land on the right sub-view. */
import { cn } from '@benord-labs/frink-primitives';
import { useAtom } from 'jotai';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useIsNarrowScreen } from '@/hooks/use-is-narrow-screen';
import { agentsSettingsDialogActiveTabAtom, type SettingsTab } from '@/lib/atoms';
import { SettingsTabHeader } from '../SettingsTabHeader';
import { SETTINGS_TAB_PAGE_WIDE_CLASS } from '../settings-tab-surface';

export type SettingsSubview = { id: SettingsTab; label: string };

const ActionsSlotContext = createContext<HTMLElement | null>(null);

/** Puts the active sub-view's page actions in the header row, right-aligned. */
export function SubviewActions({ children }: { children: ReactNode }) {
  const slot = useContext(ActionsSlotContext);
  return slot ? createPortal(children, slot) : null;
}

type Props = {
  title: string;
  /** One sentence for the whole page, so the header never changes height between sub-views. */
  description?: string;
  views: readonly [SettingsSubview, ...SettingsSubview[]];
  /** `onDetailChange(true)` hides the header and tabs while a sub-view shows a page with its own heading. */
  renderView: (id: SettingsTab, onDetailChange: (open: boolean) => void) => ReactNode;
};

export function SettingsSubviewPage({
  title,
  description,
  views,
  renderView,
}: Props): ReactElement {
  const [activeTab, setActiveTab] = useAtom(agentsSettingsDialogActiveTabAtom);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  // Keyed by the reporting view, so a detail page never hides the header for a sibling view.
  const [detailView, setDetailView] = useState<SettingsTab | null>(null);
  const isNarrowScreen = useIsNarrowScreen();
  const active = views.find((view) => view.id === activeTab) ?? views[0];
  const isDetailOpen = detailView === active.id;
  // Stable per view: a sub-view reports detail state from an effect keyed on this callback.
  const detailHandlers = useMemo(
    () =>
      views.map(
        (view) => (open: boolean) =>
          setDetailView((current) => (open ? view.id : current === view.id ? null : current)),
      ),
    [views],
  );

  return (
    <Tabs
      value={active.id}
      onValueChange={(next) => {
        const view = views.find((entry) => entry.id === next);
        if (view) setActiveTab(view.id);
      }}
      className={SETTINGS_TAB_PAGE_WIDE_CLASS}
    >
      {/* A sub-view page with its own h1 (a plugin's page) owns the heading and the way back. */}
      {isDetailOpen ? null : (
        <div>
          {/* Actions share the title's row, never the sentence's, so they cannot rewrap it. */}
          <SettingsTabHeader
            title={title}
            narrow={isNarrowScreen}
            actionsRowLayout="inline"
            className="min-h-8"
            actions={
              <div ref={setActionsSlot} className="flex shrink-0 items-center gap-2 empty:hidden" />
            }
          />
          {description ? (
            <p className={cn('mt-1 text-muted-foreground', isNarrowScreen ? 'text-xs' : 'text-sm')}>
              {description}
            </p>
          ) : null}
          <TabsList className="mt-5 flex h-auto w-full justify-start gap-6 rounded-none border-hairline border-b bg-transparent p-0">
            {views.map((view) => (
              <TabsTrigger
                key={view.id}
                value={view.id}
                className="-mb-px cursor-pointer rounded-none border-transparent border-b-2 px-0 pt-0 pb-2.5 text-muted-fg transition-colors duration-150 ease-out hover:text-ink focus-visible:ring-offset-0 data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-ink data-[state=active]:shadow-none"
              >
                {view.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      )}
      <ActionsSlotContext.Provider value={actionsSlot}>
        {views.map((view, index) => (
          <TabsContent key={view.id} value={view.id} className="mt-0">
            {renderView(view.id, detailHandlers[index])}
          </TabsContent>
        ))}
      </ActionsSlotContext.Provider>
    </Tabs>
  );
}
