import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue, useSetAtom } from 'jotai';
import type { ReactElement, ReactNode } from 'react';
import { useIsNarrowScreen } from '@/hooks/use-is-narrow-screen';
import { agentsSettingsDialogOpenAtom } from '@/lib/atoms';
import { themeEditorDraftNameAtom, themeEditorSessionAtom } from '@/lib/themes/editor/editor-atoms';
import { useStockPalettes } from '@/lib/themes/preview/use-stock-palettes';
import { cn } from '@/lib/utils';
import { FineTuneCard } from './appearance/FineTuneCard';
import { ModeSwitch } from './appearance/ModeSwitch';
import { ThemeShelf } from './appearance/ThemeShelf';
import { SettingsTabHeader } from './SettingsTabHeader';
import { SETTINGS_TAB_PAGE_WIDE_CLASS } from './settings-tab-surface';

type SectionProps = { title: string; description?: string; children: ReactNode };

function Section({ title, description, children }: SectionProps): ReactElement {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
        {description ? <p className="text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function AgentsAppearanceTab() {
  const isNarrowScreen = useIsNarrowScreen();
  const stock = useStockPalettes();
  const session = useAtomValue(themeEditorSessionAtom);
  const draftName = useAtomValue(themeEditorDraftNameAtom).trim();
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom);

  return (
    // One container rule: below 980px of content Fine-tune stacks its preview under the sliders.
    <div className={cn(SETTINGS_TAB_PAGE_WIDE_CLASS, '@container space-y-8')}>
      <SettingsTabHeader
        title="Appearance"
        description="Choose how Frink looks. Pick a theme, or make your own."
        narrow={isNarrowScreen}
        actions={<ModeSwitch />}
        actionsRowLayout={isNarrowScreen ? 'stack' : 'inline'}
      />

      <Section
        title="Themes"
        description="Click a theme to use it in light and dark, or one of its color strips to use it for just that mode."
      >
        {session ? (
          <div
            role="status"
            className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          >
            <span>
              You're editing “{draftName || session.seed.name}”. Save or cancel to switch themes.
            </span>
            <Button variant="link" size="xs" onClick={() => setSettingsOpen(false)}>
              Show editor
            </Button>
          </div>
        ) : null}
        {/* Picking a theme mid-edit would fight the editor's live preview. */}
        <div inert={session !== null} className={cn(session && 'opacity-50')}>
          <ThemeShelf stock={stock} />
        </div>
      </Section>

      <Section title="Fine-tune" description="Works on top of any theme.">
        <FineTuneCard stock={stock} />
      </Section>
    </div>
  );
}
