import { Button, cn } from '@benord-labs/frink-primitives';
import { CircleCheck, CircleOff, Loader2, RefreshCw, Server, Settings, Trash2 } from 'lucide-react';
import { memo } from 'react';
import {
  GlyphTile,
  RowDetails,
  SettingsListRow,
  SoftButton,
  WARNING_TEXT_CLASS,
} from '@/components/settings/SettingsList';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { PluginMark } from '@/features/plugins';
import { getStatusText } from '../constants';

type Props = {
  name: string;
  description?: string;
  url?: string;
  status: string;
  statusDetail?: string;
  tools?: string[];
  needsSetup: boolean;
  isExpanded: boolean;
  isReconnecting?: boolean;
  isEnabled: boolean;
  onToggle: () => void;
  onConfigure: () => void;
  onReconnect: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
  /** Plugin-registered servers only; the Plugins page owns connect, turn off and remove. */
  plugin?: { id: string; name: string };
  onOpenPluginPage?: () => void;
};

const LOCAL_SERVER = 'Runs on this computer';

// Colour is reserved for live or needs-attention states; everything else stays muted.
const STATUS_TONE = new Map<string, { dot: string; text: string }>([
  ['connected', { dot: 'bg-[hsl(var(--status-online))]', text: 'text-muted-fg' }],
  ['needs_auth', { dot: 'bg-[hsl(var(--status-warning-foreground))]', text: WARNING_TEXT_CLASS }],
  ['error', { dot: 'bg-destructive', text: 'text-destructive' }],
  ['disconnected', { dot: 'bg-destructive', text: 'text-destructive' }],
]);

function StatusWord({
  status,
  isEnabled,
  isReconnecting,
}: {
  status: string;
  isEnabled: boolean;
  isReconnecting: boolean;
}) {
  if (!isEnabled) return <span className="text-dim text-xs">Off</span>;
  if (isReconnecting) {
    return (
      <span className="flex items-center gap-1.5 text-muted-fg text-xs">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Reconnecting
      </span>
    );
  }
  const tone = STATUS_TONE.get(status) ?? {
    dot: 'bg-muted-foreground/60 motion-safe:animate-pulse',
    text: 'text-muted-fg',
  };
  return (
    <span className={cn('flex items-center gap-1.5 text-xs', tone.text)}>
      <span className={cn('size-1.5 rounded-full', tone.dot)} aria-hidden />
      {getStatusText(status)}
    </span>
  );
}

function ToolList({ tools }: { tools: string[] }) {
  if (tools.length === 0) return <span className="text-muted-fg">None reported yet</span>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Tools">
      {tools.map((tool) => (
        <li
          key={tool}
          className="rounded-md border border-hairline px-1.5 py-0.5 font-mono text-[11px] text-muted-fg"
        >
          {tool}
        </li>
      ))}
    </ul>
  );
}

export const McpServerRow = memo(function McpServerRow({
  name,
  description,
  url,
  status,
  statusDetail,
  tools = [],
  needsSetup,
  isExpanded,
  isReconnecting = false,
  isEnabled,
  onToggle,
  onConfigure,
  onReconnect,
  onToggleEnabled,
  onDelete,
  plugin,
  onOpenPluginPage,
}: Props) {
  const statusWord = (
    <StatusWord status={status} isEnabled={isEnabled} isReconnecting={isReconnecting} />
  );
  const failure = isEnabled && statusDetail ? statusDetail : undefined;

  // A plugin's server is connected, turned off and removed on the Plugins page.
  if (plugin && onOpenPluginPage) {
    return (
      <SettingsListRow
        id={name}
        tile={<PluginMark pluginId={plugin.id} className="size-10 rounded-xl" markSize="1.5rem" />}
        name={name}
        description={failure ?? `Set up by the ${plugin.name} plugin`}
        descriptionClassName={failure ? 'text-destructive' : undefined}
        status={statusWord}
        expanded={isExpanded}
        onToggle={onToggle}
        details={
          <>
            <p className="text-sm text-muted-fg leading-relaxed">
              {`${plugin.name} manages this server.`}
            </p>
            <RowDetails items={[{ label: 'Tools', value: <ToolList tools={tools} /> }]} />
            <SoftButton onClick={onOpenPluginPage}>Manage</SoftButton>
          </>
        }
      />
    );
  }

  const note = !isEnabled
    ? "Turned off. Your agents can't use it until you turn it back on."
    : needsSetup
      ? 'Sign in or add a key so your agents can use it.'
      : null;

  return (
    <SettingsListRow
      id={name}
      tile={<GlyphTile icon={Server} />}
      name={name}
      description={failure || description || 'No description'}
      descriptionClassName={failure ? 'text-destructive' : description ? undefined : 'text-dim'}
      status={statusWord}
      dimmed={!isEnabled}
      expanded={isExpanded}
      onToggle={onToggle}
      details={
        <>
          {note ? <p className="text-sm text-muted-fg leading-relaxed">{note}</p> : null}
          <RowDetails
            items={[
              { label: 'Tools', value: <ToolList tools={tools} /> },
              { label: 'Address', value: <span className="break-all">{url ?? LOCAL_SERVER}</span> },
            ]}
          />
          <div className="flex flex-wrap gap-2">
            <SoftButton onClick={onConfigure}>{needsSetup ? 'Set up' : 'Configure'}</SoftButton>
            <SoftButton onClick={onReconnect}>Reconnect</SoftButton>
            <SoftButton onClick={onToggleEnabled}>{isEnabled ? 'Turn off' : 'Turn on'}</SoftButton>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10"
              onClick={onDelete}
            >
              Remove
            </Button>
          </div>
        </>
      }
      menu={
        <>
          <DropdownMenuItem onClick={onConfigure}>
            <Settings className="mr-2 size-3.5" />
            Configure
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onReconnect}>
            <RefreshCw className="mr-2 size-3.5" />
            Reconnect
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onToggleEnabled}>
            {isEnabled ? (
              <CircleOff className="mr-2 size-3.5" />
            ) : (
              <CircleCheck className="mr-2 size-3.5" />
            )}
            {isEnabled ? 'Turn off' : 'Turn on'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDelete} className="text-destructive">
            <Trash2 className="mr-2 size-3.5" />
            Remove
          </DropdownMenuItem>
        </>
      }
    />
  );
});
