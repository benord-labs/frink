import mcpLogo from '@iconify-icons/simple-icons/modelcontextprotocol';
import defaultFileIcon from '@iconify-icons/vscode-icons/default-file';
import { fileTypeIcon } from '@frink/shared/lib/file-type-icons';
import type { MobileTextRun } from '@frink/shared/types/remote/mobile';
import {
  Bot,
  FolderOpen,
  Image as ImageIcon,
  SquareDashedText,
  ToolCase,
} from 'lucide-react-native';
import { useMemo } from 'react';
import { SvgXml } from 'react-native-svg';
import { useTheme } from '../../../ui/theme';
import type { Attachment } from './parts';

type IconifyData = { body: string; left?: number; top?: number; width?: number; height?: number };

/** One of the desktop's Iconify glyphs (file types, the MCP mark), drawn from its SVG body. */
function Iconify({ icon, size, color }: { icon: IconifyData; size: number; color: string }) {
  const { body, left = 0, top = 0, width = 16, height = 16 } = icon;
  const xml = useMemo(
    () =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}">${body}</svg>`,
    [body, left, top, width, height],
  );
  return <SvgXml xml={xml} width={size} height={size} color={color} />;
}

/** A file's type icon, as the desktop picks it from the name, or VS Code's plain file icon. */
function FileIcon({ name, size }: { name: string; size: number }) {
  const t = useTheme();
  return <Iconify icon={fileTypeIcon(name) ?? defaultFileIcon} size={size} color={t.secondary} />;
}

// The desktop's glyph for each kind of mention that is not a file. A kind a newer Mac adds, which
// this build has never seen, gets the file icon rather than nothing.
const KIND_ICONS = new Map<string, typeof Bot>([
  ['folder', FolderOpen],
  ['skill', ToolCase],
  ['agent', Bot],
]);

/** A mention's icon, as on the desktop: the file's type, a folder, a skill, an agent or an MCP tool. */
export function MentionIcon({
  kind,
  name,
  size = 14,
}: {
  kind: NonNullable<MobileTextRun['mention']>;
  name: string;
  size?: number;
}) {
  const t = useTheme();
  const Icon = KIND_ICONS.get(kind);
  if (Icon) return <Icon size={size} color={t.secondary} />;
  if (kind === 'tool') return <Iconify icon={mcpLogo} size={size} color={t.secondary} />;
  return <FileIcon name={name} size={size} />;
}

/** An attachment's icon: an image, selected words, or the file's type. */
export function AttachmentIcon({ item, size = 14 }: { item: Attachment; size?: number }) {
  const t = useTheme();
  if (item.kind === 'image') return <ImageIcon size={size} color={t.secondary} />;
  if (item.kind === 'text') return <SquareDashedText size={size} color={t.secondary} />;
  return <FileIcon name={item.name} size={size} />;
}
