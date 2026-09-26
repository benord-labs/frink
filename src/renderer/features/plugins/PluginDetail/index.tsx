/**
 * A plugin's page: what it installs, stated before any account is connected.
 * Replaces the settings tab's content rather than opening over it, so the set
 * can be read at length. Every responsive decision is a CONTAINER query off the
 * frame below, since a settings pane is never the viewport.
 */
import { useEffect, useRef } from 'react';
import { hasOpenDialogLayer } from '../../../lib/has-open-dialog-layer';
import { isEditableKeyboardTarget } from '../../../lib/is-editable-keyboard-target';
import { trpc } from '../../../lib/trpc';
import { PluginBody } from './PluginBody';
import { PluginBreadcrumb } from './PluginBreadcrumb';
import type { PluginActions } from './PluginPageHeader';

/** Matches `DirectoryFrame`, so content does not shift sideways when the page opens. */
const FRAME = 'mx-auto w-full max-w-[68rem] pb-12';

type Props = PluginActions & {
  /** Matches `PluginDefinition.id`, which for built-ins is the provider id. */
  pluginId: string;
  onBack: () => void;
};

export function PluginDetail({
  pluginId,
  isConnecting,
  onBack,
  onConnect,
  onSelectAccount,
}: Props) {
  const { data, isLoading, isError } = trpc.plugins.list.useQuery();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Not a dialog, so nothing moves focus for us: without this the activating
  // button is display:none'd and the next Tab restarts at the top of the app.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Capture phase: SettingsPage's own Escape listener closes the whole Settings
  // destination unless `defaultPrevented`, and bubble ordering between the two
  // is not a contract this page can hold.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (isEditableKeyboardTarget(event.target) || hasOpenDialogLayer()) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onBack]);

  const plugin = data?.plugins.find((candidate) => candidate.definition.id === pluginId);

  return (
    <div className={`${FRAME} @container`} data-testid="plugin-page">
      {/* Renders in every state on purpose: a failed refetch must keep a way back. */}
      <PluginBreadcrumb name={plugin?.definition.name} onBack={onBack} headingRef={headingRef} />
      <PluginBody
        plugin={plugin}
        isLoading={isLoading}
        // A refetch failure keeps the previous data, so a still-usable catalogue is rendered.
        isError={isError && !data}
        isConnecting={isConnecting}
        onConnect={onConnect}
        onSelectAccount={onSelectAccount}
      />
    </div>
  );
}
