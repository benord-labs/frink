/**
 * Shared icon component for flow block types.
 */

import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Bell,
  Bot,
  Box,
  CalendarClock,
  CheckCircle,
  CircleStop,
  Clipboard,
  Cloud,
  Code,
  Database,
  FileCode,
  FileText,
  Folder,
  GitBranch,
  Globe,
  Hammer,
  Inbox,
  Layers,
  ListChecks,
  ListRestart,
  Mail,
  MessageCircle,
  MessageSquare,
  Package,
  Play,
  Rocket,
  Search,
  Send,
  Server,
  Shield,
  Sparkles,
  Terminal,
  Webhook,
  Workflow,
  Wrench,
  Zap,
} from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { findPluginActionByNodeName } from '../../../../../shared/integrations/plugin-nodes';
import {
  type CustomNodeIconKey,
  isKnownCustomNodeIconKey,
} from '../../../../../shared/lib/custom-node-icon-allowlist';
import type { FlowBlockType } from '../../../../../shared/types/flow';
import { BRAND_TILE_RIM_STYLE, ProviderIcon } from '../../../../components/ProviderIcon';
import { cn } from '../../../../lib/utils';
import { blockIconSurfaceClass } from '../FlowCanvas/flowStepNodeStyles';

/** Curated manifest icons — keys match `CUSTOM_NODE_ICON_KEY_LIST` (lowercase kebab). */
const CUSTOM_BLOCK_ICONS = {
  activity: Activity,
  bell: Bell,
  bot: Bot,
  box: Box,
  calendar: CalendarClock,
  'check-circle': CheckCircle,
  clipboard: Clipboard,
  cloud: Cloud,
  code: Code,
  database: Database,
  'file-code': FileCode,
  'file-text': FileText,
  folder: Folder,
  'git-branch': GitBranch,
  globe: Globe,
  hammer: Hammer,
  inbox: Inbox,
  layers: Layers,
  mail: Mail,
  'message-square': MessageSquare,
  package: Package,
  search: Search,
  send: Send,
  server: Server,
  shield: Shield,
  sparkles: Sparkles,
  terminal: Terminal,
  webhook: Webhook,
  workflow: Workflow,
  wrench: Wrench,
  zap: Zap,
} as const satisfies { [K in CustomNodeIconKey]: LucideIcon };

type FlowBlockIconProps = {
  type: FlowBlockType | string;
  className?: string;
  /** Lucide key from custom node manifest when `type` is a custom block name. */
  customBlockIcon?: string | null;
};

export function FlowBlockIcon({
  type,
  className = 'h-4 w-4',
  customBlockIcon,
}: FlowBlockIconProps): ReactElement {
  switch (type) {
    case 'manual_trigger':
      return <Play className={className} aria-hidden />;
    case 'webhook_trigger':
      return <Webhook className={className} aria-hidden />;
    case 'post_task_trigger':
      return <ListChecks className={className} aria-hidden />;
    case 'schedule_trigger':
      return <CalendarClock className={className} aria-hidden />;
    case 'start_task':
      return <Rocket className={className} aria-hidden />;
    case 'agent':
      return <Sparkles className={className} aria-hidden />;
    case 'chat_reply':
      return <MessageCircle className={className} aria-hidden />;
    case 'run_command':
      return <Terminal className={className} aria-hidden />;
    case 'http_request':
      return <Globe className={className} aria-hidden />;
    case 'condition':
      return <GitBranch className={className} aria-hidden />;
    case 'fan_out':
      return <ListRestart className={className} aria-hidden />;
    case 'approval':
      return <CheckCircle className={className} aria-hidden />;
    case 'end':
      return <CircleStop className={className} aria-hidden />;
    default: {
      const key = customBlockIcon?.trim().toLowerCase();
      // biome-ignore lint/style/useNamingConvention: component type variable
      const CustomIcon =
        key && isKnownCustomNodeIconKey(key) && key in CUSTOM_BLOCK_ICONS
          ? CUSTOM_BLOCK_ICONS[key as keyof typeof CUSTOM_BLOCK_ICONS]
          : Bot;
      return <CustomIcon className={className} aria-hidden />;
    }
  }
}

type FlowBlockTileProps = {
  type: FlowBlockType | string;
  customBlockIcon?: string | null;
  /** The smaller tile that sits in a canvas card's header. */
  compact?: boolean;
  /** Status badges pinned to the tile's corners. */
  children?: ReactNode;
};

/** A step's identity tile: the provider's own mark for a plugin step, else the block-type icon. */
export function FlowBlockTile({
  type,
  customBlockIcon,
  compact = false,
  children,
}: FlowBlockTileProps): ReactElement {
  const providerId = findPluginActionByNodeName(type)?.pluginId;
  const iconSize = compact ? 'size-4' : 'size-[18px]';
  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center',
        compact ? 'size-7 rounded-lg' : 'size-9 rounded-[10px]',
        !providerId && blockIconSurfaceClass(type),
      )}
      style={providerId ? BRAND_TILE_RIM_STYLE : undefined}
    >
      {providerId ? (
        <ProviderIcon providerId={providerId} appearance="tile" className={iconSize} />
      ) : (
        <FlowBlockIcon type={type} customBlockIcon={customBlockIcon} className={iconSize} />
      )}
      {children}
    </div>
  );
}
