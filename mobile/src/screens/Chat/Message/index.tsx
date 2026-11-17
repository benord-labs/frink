import * as Clipboard from 'expo-clipboard';
import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Check, Copy, CornerDownRight } from 'lucide-react-native';
import type { MobileMessage, MobileTextRun } from '@frink/shared/types/remote/mobile';
import { GlassSurface } from '../../../ui/material';
import { Markdown } from '../../../ui/Markdown';
import { Text } from '../../../ui/text';
import { radius, space, useTheme } from '../../../ui/theme';
import { Note } from '../note';
import { PlanCard, type PendingPlan } from '../plan';
import { AttachmentIcon } from './mention-icon';
import { MentionText } from './mention-text';
import { attachmentsOf, contentGroups, copyText, type Attachment, type Group } from './parts';
import { ToolRun } from './tool-run';

/** The phone's own words: a right-aligned bubble on the shared glass material. */
function Bubble({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <GlassSurface
      style={{
        maxWidth: '84%',
        paddingHorizontal: compact ? space.md : 14,
        paddingVertical: compact ? space.sm : 10,
        borderRadius: compact ? radius.lg : radius.xl,
      }}
    >
      {children}
    </GlassSurface>
  );
}

/** A note steered into a running turn: the user's words, tagged so it reads as mid-turn. */
function SteerBubble({ text, runs }: { text: string; runs?: MobileTextRun[] }) {
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
        <MentionText variant="secondary" text={text} runs={runs} />
      </Bubble>
    </View>
  );
}

type Prose = Extract<Group, { type: 'text' }>;

const ATTACHMENT_WORD = {
  image: 'Image',
  file: 'File',
  text: 'Selected text',
} satisfies Record<Attachment['kind'], string>;

/** What was attached to a message, as the desktop's badges; the files stay on the computer. */
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
      {items.map((item, index) => (
        <View
          key={`${item.name}-${index}`}
          accessibilityLabel={`${ATTACHMENT_WORD[item.kind]}: ${[item.name, item.detail].filter(Boolean).join(' ')}`}
          style={{
            maxWidth: 240,
            height: 28,
            paddingHorizontal: space.sm,
            borderRadius: 6,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            backgroundColor: t.accentSoft,
          }}
        >
          <AttachmentIcon item={item} />
          <Text variant="secondary" numberOfLines={1} style={{ flexShrink: 1, fontWeight: '500' }}>
            {item.name}
          </Text>
          {!!item.detail && (
            <Text variant="secondary" color="secondary">
              · {item.detail}
            </Text>
          )}
        </View>
      ))}
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
  if (group.type === 'steer') return <SteerBubble text={group.text} runs={group.runs} />;
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
  if (message.role === 'user') {
    const prose = groups.filter((group): group is Prose => group.type === 'text');
    return (
      <View testID={`message-${message.id}`} style={{ alignItems: 'flex-end', gap: 6 }}>
        <AttachmentChips items={attachments} end />
        {prose.length > 0 && (
          <Bubble>
            <View style={{ gap: space.sm }}>
              {prose.map((group, index) => (
                <MentionText key={`${index}-${group.text}`} text={group.text} runs={group.runs} />
              ))}
            </View>
          </Bubble>
        )}
      </View>
    );
  }
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
