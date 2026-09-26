import { Button } from '@benord-labs/frink-primitives';
import type { ResolvedPlugin } from '../../../../../shared/integrations/plugins';
import type { usePluginChatTools } from '../../../../hooks/usePluginChatTools';
import {
  connectSubline,
  type PluginConnectAction,
  type PluginStatus,
} from '../../../../lib/plugins/plugin-view-model';
import { PluginMark } from '../../PluginMark';
import { PluginDisconnect } from '../PluginDisconnect';
import { PluginStatusBadge } from '../../PluginStatusBadge';

/** Carried down to whichever tier draws the connect and account controls. */
export type PluginActions = {
  /** Delivery health of this plugin's live account, so the badge cannot claim Connected. */
  /** True only for this plugin's own connect, never any other provider's. */
  isConnecting: boolean;
  onConnect: (pluginId: string) => void;
  onSelectAccount: (connectionId: string) => void;
};

export function PluginPageHeader({
  plugin,
  status,
  connect,
  connecting,
  describedBy,
  onSelectAccount,
  chat,
  onChatGrant,
}: {
  plugin: ResolvedPlugin;
  /** Resolved once by the page, so the badge, this button and the body's prerequisite sentence never disagree. */
  status: PluginStatus;
  connect: PluginConnectAction | null;
  connecting: boolean;
  /** Id of the body's prerequisite sentence, when the plugin owes one. */
  describedBy?: string;
  onSelectAccount: (connectionId: string) => void;
  chat: ReturnType<typeof usePluginChatTools>;
  /** Runs the whole connect chain — in-app legs (a pasted token) first, then the browser — skipping satisfied grants; the page's locked prompts share it. */
  onChatGrant: () => void;
}) {
  const { id, name, description } = plugin.definition;
  const subline = status.id === 'needs_connection' ? connectSubline(plugin, chat.state) : null;
  const active = plugin.connections.filter((connection) => connection.isActive);
  // Exactly one, never "the first of several": several fall through to the
  // Accounts row, the only surface that can disambiguate them.
  const onlyAccount = active.length === 1 ? active[0] : undefined;

  return (
    <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
      {/* `grow`, not `flex-1`: the shorthand resets the basis and lets the identity block collapse at a narrow pane. */}
      <div className="flex min-w-0 grow basis-[24rem] items-start gap-4">
        <PluginMark pluginId={id} className="size-11 rounded-xl" markSize="1.5rem" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="min-w-0 break-words font-semibold text-[1.75rem] text-ink leading-tight tracking-[-0.02em]">
              {name}
            </p>
            <PluginStatusBadge status={status} />
          </div>
          <p className="mt-1.5 max-w-[52ch] text-base text-muted-fg leading-snug">{description}</p>
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        <div className="flex items-center gap-2">
          {connect?.placement === 'primary' ? (
            <Button
              size="sm"
              loading={connecting}
              aria-label={connect.ariaLabel}
              aria-describedby={describedBy}
              onClick={onChatGrant}
            >
              {connect.label}
            </Button>
          ) : null}
          <PluginDisconnect
            plugin={plugin}
            hasAccount={plugin.connections.length > 0}
            toolsConnected={chat.state === 'connected'}
            onSelectAccount={onlyAccount ? () => onSelectAccount(onlyAccount.id) : undefined}
            connect={
              connect?.placement === 'menu'
                ? { label: connect.label, loading: connecting, describedBy, onSelect: onChatGrant }
                : undefined
            }
          />
        </div>
        {subline ? (
          <p className="max-w-[38ch] text-right text-muted-fg text-xs leading-snug">{subline}</p>
        ) : null}
      </div>
    </header>
  );
}
