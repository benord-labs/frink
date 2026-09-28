import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MobileMessage } from '../../../../../src/shared/types/remote/mobile';
import { Markdown } from '../../../ui/Markdown';
import { Icon, Notice, type IconName } from '../../../ui/primitives';
import { glassStyle } from '../../../ui/material';
import { useTheme, type Theme } from '../../../ui/theme';

type Part = NonNullable<MobileMessage['parts']>[number];
type Tool = Extract<Part, { type: 'tool' }>;
type Attachment = Extract<Part, { type: 'attachment' }>;

const toolStates: Record<Tool['state'], { label: string; icon: IconName }> = {
  failed: { label: 'Failed', icon: 'alert-circle' },
  running: { label: 'Working', icon: 'ellipsis-horizontal-circle' },
  completed: { label: 'Complete', icon: 'checkmark-circle' },
  interrupted: { label: 'Stopped', icon: 'stop-circle-outline' },
  unknown: { label: 'Status unavailable', icon: 'help-circle-outline' },
};

function toolColor(t: Theme, state: Tool['state']) {
  if (state === 'failed') return t.danger;
  if (state === 'running') return t.accent;
  if (state === 'completed') return t.success;
  return t.muted;
}

// Reason: Running, failed and expanded activity states share one disclosure.
// fallow-ignore-next-line complexity
function Activity({ tools }: { tools: Tool[] }) {
  const [expanded, setExpanded] = useState(false);
  const t = useTheme();
  const running = tools.some((tool) => tool.state === 'running');
  const failed = tools.some((tool) => tool.state === 'failed');
  const count = `${tools.length} ${tools.length === 1 ? 'activity' : 'activities'}`;
  const summary: Tool['state'] = running ? 'running' : failed ? 'failed' : 'completed';
  return (
    <View
      style={{
        ...glassStyle(t),
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 12,
        overflow: 'hidden',
        marginBottom: 12,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${count}${running ? ', working' : ''}`}
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => ({
          height: 44,
          paddingHorizontal: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          backgroundColor: pressed ? t.fill : 'transparent',
        })}
      >
        <Icon name="construct-outline" size={16} color={t.muted} />
        <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: t.secondary }}>
          {count}
          {running ? ' · Working' : failed ? ' · Something failed' : ''}
        </Text>
        <Icon name={toolStates[summary].icon} size={16} color={toolColor(t, summary)} />
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={t.muted} />
      </Pressable>
      {expanded &&
        tools.map((tool) => (
          <View
            key={tool.id}
            style={{
              minHeight: 40,
              paddingHorizontal: 12,
              paddingVertical: 10,
              flexDirection: 'row',
              gap: 10,
              alignItems: 'flex-start',
              borderTopWidth: StyleSheet.hairlineWidth,
              borderColor: t.border,
            }}
          >
            <View style={{ paddingTop: 2 }}>
              <Icon name={toolStates[tool.state].icon} size={16} color={toolColor(t, tool.state)} />
            </View>
            <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: t.text }}>
              {tool.name}
              <Text style={{ color: t.muted }}>{` · ${toolStates[tool.state].label}`}</Text>
            </Text>
          </View>
        ))}
    </View>
  );
}

// Reason: Merges adjacent tool parts and drops empty text in one pass.
// fallow-ignore-next-line complexity
function contentGroups(parts: Part[]) {
  const groups: Array<{ type: 'text'; text: string } | { type: 'tools'; tools: Tool[] }> = [];
  for (const part of parts) {
    const last = groups[groups.length - 1];
    if (part.type === 'tool') {
      if (last?.type === 'tools') last.tools.push(part);
      else groups.push({ type: 'tools', tools: [part] });
    } else if (part.type === 'text' && part.text) groups.push({ type: 'text', text: part.text });
  }
  return groups;
}

// Reason: Copied and copy-failed feedback share one control.
// fallow-ignore-next-line complexity
function CopyAction({ text }: { text: string }) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  async function copy() {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copied ? 'Message copied' : 'Copy message'}
        onPress={() => void copy()}
        hitSlop={10}
        style={({ pressed }) => ({
          alignSelf: 'flex-start',
          height: 24,
          flexDirection: 'row',
          gap: 6,
          alignItems: 'center',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon name={copied ? 'checkmark' : 'copy-outline'} size={17} color={t.muted} />
        {copied && <Text style={{ fontSize: 12, lineHeight: 16, color: t.muted }}>Copied</Text>}
      </Pressable>
      {copyError && <Notice error>Could not copy. Select the text to copy it.</Notice>}
    </>
  );
}

/** What was attached to a message; the files themselves stay on the computer. */
function Attachments({ items, align }: { items: Attachment[]; align: 'flex-start' | 'flex-end' }) {
  const t = useTheme();
  if (!items.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: align }}>
      {items.map((item, index) => (
        <View
          key={`${item.name}-${index}`}
          accessibilityLabel={`${item.kind === 'image' ? 'Image' : 'File'}: ${item.name}`}
          style={{
            maxWidth: 220,
            height: 30,
            paddingHorizontal: 10,
            borderRadius: 15,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            backgroundColor: t.fill,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.border,
          }}
        >
          <Icon
            name={item.kind === 'image' ? 'image-outline' : 'document-attach-outline'}
            size={14}
            color={t.secondary}
          />
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: t.secondary }}>
            {item.name}
          </Text>
        </View>
      ))}
    </View>
  );
}

// Reason: User bubbles and assistant parts are one message renderer.
// fallow-ignore-next-line complexity
export function Message({ message }: { message: MobileMessage }) {
  const t = useTheme();
  const isUser = message.role === 'user';
  const attachments = (message.parts ?? []).filter(
    (part): part is Attachment => part.type === 'attachment',
  );
  const groups = contentGroups(
    message.parts?.length ? message.parts : [{ type: 'text', text: message.text }],
  );
  const text = groups
    .filter((group) => group.type === 'text')
    .map((group) => group.text)
    .join('\n\n');
  if (isUser)
    return (
      <View testID={`message-${message.id}`} style={{ alignItems: 'flex-end', gap: 6 }}>
        <Attachments items={attachments} align="flex-end" />
        {!!text && (
          <View
            style={{
              maxWidth: '86%',
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderRadius: 20,
              borderBottomRightRadius: 6,
              backgroundColor: t.raised,
            }}
          >
            <Text selectable style={{ color: t.text, fontSize: 16, lineHeight: 22 }}>
              {text}
            </Text>
          </View>
        )}
      </View>
    );
  return (
    <View testID={`message-${message.id}`} style={{ alignSelf: 'stretch', gap: 4 }}>
      {message.role === 'system' && (
        <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '600', color: t.muted }}>
          System
        </Text>
      )}
      <Attachments items={attachments} align="flex-start" />
      <View>
        {groups.map((group, index) =>
          group.type === 'tools' ? (
            <Activity key={`activity-${index}`} tools={group.tools} />
          ) : (
            <Markdown key={`text-${index}`} content={group.text} />
          ),
        )}
      </View>
      {!!text && <CopyAction text={text} />}
    </View>
  );
}
