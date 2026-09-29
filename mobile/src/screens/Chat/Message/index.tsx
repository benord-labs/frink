import * as Clipboard from 'expo-clipboard';
import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Check, Copy, CornerDownRight, FileText, Image as ImageIcon } from 'lucide-react-native';
import type { MobileMessage } from '@frink/shared/types/remote/mobile';
import { Markdown } from '../../../ui/Markdown';
import { glassLighting } from '../../../ui/material';
import { Text } from '../../../ui/text';
import { radius, space, useTheme } from '../../../ui/theme';
import { Note } from '../note';
import { PlanCard, type PendingPlan } from '../plan';
import { attachmentsOf, contentGroups, copyText, type Attachment, type Group } from './parts';
import { ToolRun } from './tool-run';

/** The phone's own words: a right-aligned bubble on a faint lit fill. */
function Bubble({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          maxWidth: '84%',
          paddingHorizontal: compact ? space.md : 14,
          paddingVertical: compact ? space.sm : 10,
          borderRadius: compact ? radius.lg : radius.xl,
          backgroundColor: t.dark ? 'rgba(255,255,255,0.08)' : t.field,
        },
        glassLighting(t),
      ]}
    >
      {children}
    </View>
  );
}

/** A note steered into a running turn: the user's words, tagged so it reads as mid-turn. */
function SteerBubble({ text }: { text: string }) {
  const t = useTheme();
  return (
    <View
      accessibilityLabel={`Steered, picked up at the next step: ${text}`}
      style={{ alignItems: 'flex-end', gap: space.xs, marginVertical: space.xs }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
        <CornerDownRight size={13} color={t.muted} strokeWidth={2.2} />
        <Text variant="label" color="muted">
          Steered
        </Text>
      </View>
      <Bubble compact>
        <Text variant="secondary" selectable>
          {text}
        </Text>
      </Bubble>
    </View>
  );
}

/** What was attached to a message; the files themselves stay on the computer. */
function AttachmentChips({ items, end }: { items: Attachment[]; end: boolean }) {
  const t = useTheme();
  if (!items.length) return null;
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        justifyContent: end ? 'flex-end' : 'flex-start',
      }}
    >
      {items.map((item, index) => {
        const Icon = item.kind === 'image' ? ImageIcon : FileText;
        return (
          <View
            key={`${item.name}-${index}`}
            accessibilityLabel={`${item.kind === 'image' ? 'Image' : 'File'}: ${item.name}`}
            style={{
              maxWidth: 240,
              height: 32,
              paddingHorizontal: space.md,
              borderRadius: radius.pill,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              backgroundColor: t.fill,
              borderWidth: 1,
              borderColor: t.borderSubtle,
            }}
          >
            <Icon size={14} color={t.muted} />
            <Text variant="secondary" color="secondary" numberOfLines={1} style={{ flexShrink: 1 }}>
              {item.name}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function CopyAction({ text }: { text: string }) {
  const t = useTheme();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try {
      await Clipboard.setStringAsync(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  }
  const copied = state === 'copied';
  return (
    <View style={{ gap: space.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copied ? 'Message copied' : 'Copy message'}
        onPress={() => void copy()}
        hitSlop={12}
        style={({ pressed }) => ({
          alignSelf: 'flex-start',
          height: 28,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          opacity: pressed ? 0.5 : 0.85,
        })}
      >
        {copied ? (
          <Check size={15} color={t.muted} strokeWidth={2.2} />
        ) : (
          <Copy size={15} color={t.muted} strokeWidth={2} />
        )}
        {copied && (
          <Text variant="label" color="muted">
            Copied
          </Text>
        )}
      </Pressable>
      {state === 'failed' && (
        <Note error>Couldn’t copy. Press and hold the text to select it.</Note>
      )}
    </View>
  );
}

function AssistantGroup({ group, plan }: { group: Group; plan?: PendingPlan }) {
  if (group.type === 'tools') return <ToolRun tools={group.tools} />;
  if (group.type === 'steer') return <SteerBubble text={group.text} />;
  if (group.type === 'plan')
    return <PlanCard text={group.text} pending={plan?.id === group.id ? plan : undefined} />;
  return <Markdown content={group.text} />;
}

/** One message. Only the newest reply (`latest`) carries a Copy button, so a long chat isn't a
 *  column of repeated icons; earlier replies stay selectable. `plan` is the one awaiting review. */
export function Message({
  message,
  latest = false,
  plan,
}: {
  message: MobileMessage;
  latest?: boolean;
  plan?: PendingPlan;
}) {
  const groups = contentGroups(message);
  const attachments = attachmentsOf(message);
  const text = copyText(groups);
  // Copy sits under the last prose or plan, not after trailing tool steps.
  const lastText = latest
    ? groups.findLastIndex((group) => group.type === 'text' || group.type === 'plan')
    : -1;
  if (message.role === 'user')
    return (
      <View testID={`message-${message.id}`} style={{ alignItems: 'flex-end', gap: 6 }}>
        <AttachmentChips items={attachments} end />
        {!!text && (
          <Bubble>
            <Text selectable>{text}</Text>
          </Bubble>
        )}
      </View>
    );
  return (
    <View testID={`message-${message.id}`} style={{ alignSelf: 'stretch', gap: space.sm }}>
      {message.role === 'system' && (
        <Text variant="label" color="muted">
          System
        </Text>
      )}
      <AttachmentChips items={attachments} end={false} />
      {groups.map((group, index) => (
        <View key={`${group.type}-${index}`} style={{ gap: space.xs }}>
          <AssistantGroup group={group} plan={plan} />
          {index === lastText && <CopyAction text={text} />}
        </View>
      ))}
    </View>
  );
}
