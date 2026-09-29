import { Pressable, View } from 'react-native';
import { Check, MessageSquare, SkipForward } from 'lucide-react-native';
import type { MobileRunNode } from '@frink/shared/types/remote/mobile';
import { useRootNavigation } from '../../../navigation/routes';
import { Button } from '../../../ui/button';
import { StatusGlyph } from '../../../ui/glyphs';
import { Markdown } from '../../../ui/Markdown';
import { Text } from '../../../ui/text';
import { GUTTER, space, useTheme } from '../../../ui/theme';
import { plainDetail, stepStatus, stepTrailing, TONE_TEXT } from '../run-view';

export type Resume = (node: MobileRunNode, action: 'approve' | 'skip') => void;
/** What every step needs to offer its decision: whether the Mac can act, and the last failure. */
type DecisionState = {
  busy: boolean;
  ready: boolean;
  error: { nodeId: string; text: string | null } | null;
  resume: Resume;
};

// Steps that need a decision show their detail in full: it is what the user is deciding on.
function Detail({ node, full }: { node: MobileRunNode; full: boolean }) {
  if (!node.detail) return null;
  if (full) return <Markdown content={node.detail} />;
  return (
    <Text variant="secondary" color="muted" numberOfLines={2}>
      {plainDetail(node.detail)}
    </Text>
  );
}

/** A quiet link to the step's conversation; a pill per step would crowd the timeline. */
function ChatLink({ node }: { node: MobileRunNode }) {
  const t = useTheme();
  const navigation = useRootNavigation();
  const chatId = node.chatId;
  if (!chatId) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open chat for ${node.label}`}
      hitSlop={10}
      onPress={() =>
        navigation.navigate('Chat', { id: chatId, subChatId: node.subChatId ?? undefined })
      }
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 6,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <MessageSquare size={15} color={t.secondary} />
      <Text variant="secondary" color="secondary" style={{ fontWeight: '600' }}>
        Open chat
      </Text>
    </Pressable>
  );
}

function Decision({ node, state }: { node: MobileRunNode; state: DecisionState }) {
  if (!node.actions.length) return null;
  const { busy, ready, error, resume } = state;
  const failure = error?.nodeId === node.id ? error.text : null;
  const note = failure ?? (ready ? null : 'Open Frink on your Mac to continue this run.');
  // Approve goes grey while the Mac can't act: a disabled accent pill reads as muddy.
  return (
    <View style={{ gap: space.sm, paddingVertical: space.xs }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {node.actions.includes('approve') && (
          <Button
            small
            variant={ready ? 'primary' : 'secondary'}
            icon={Check}
            disabled={busy || !ready}
            accessibilityLabel={`Approve ${node.label}`}
            onPress={() => resume(node, 'approve')}
          >
            Approve
          </Button>
        )}
        {node.actions.includes('skip') && (
          <Button
            small
            variant="secondary"
            icon={SkipForward}
            disabled={busy || !ready}
            accessibilityLabel={`Skip ${node.label}`}
            onPress={() => resume(node, 'skip')}
          >
            Skip step
          </Button>
        )}
      </View>
      {note && (
        <Text variant="secondary" color={failure ? 'danger' : 'muted'}>
          {note}
        </Text>
      )}
    </View>
  );
}

function Step({ node, last, state }: { node: MobileRunNode; last: boolean; state: DecisionState }) {
  const t = useTheme();
  const status = stepStatus(node);
  const trailing = stepTrailing(node);
  const decide = node.actions.length > 0 || node.status === 'failed';
  return (
    <View
      testID={`run-step-${node.id}`}
      accessibilityLabel={`${node.label}, ${status.word}`}
      style={{ flexDirection: 'row', gap: space.md, paddingHorizontal: GUTTER }}
    >
      <View style={{ width: 22, alignItems: 'center' }}>
        <View style={{ height: 21, justifyContent: 'center' }}>
          <StatusGlyph glyph={status.glyph} tone={status.tone} size={20} />
        </View>
        {!last && (
          <View
            style={{
              flex: 1,
              width: 2,
              borderRadius: 1,
              marginVertical: space.xs,
              backgroundColor: t.border,
            }}
          />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: space.xs, paddingBottom: last ? 0 : space.xl }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
          <Text
            variant="row"
            color={status.glyph === 'never' ? 'secondary' : 'text'}
            style={{ flex: 1 }}
          >
            {node.label}
          </Text>
          {trailing && (
            <Text
              variant="secondary"
              color={TONE_TEXT[trailing.tone]}
              style={{ fontVariant: ['tabular-nums'], lineHeight: 21 }}
            >
              {trailing.text}
            </Text>
          )}
        </View>
        <Detail node={node} full={decide} />
        <Decision node={node} state={state} />
        <ChatLink node={node} />
      </View>
    </View>
  );
}

/** A run's steps top to bottom, joined by a rail, each with its state glyph and timing. */
export function RunTimeline({ nodes, ...state }: DecisionState & { nodes: MobileRunNode[] }) {
  if (!nodes.length)
    return (
      <Text variant="secondary" color="muted" style={{ paddingHorizontal: GUTTER }}>
        Frink is getting the first step ready.
      </Text>
    );
  return (
    <View>
      {nodes.map((node, index) => (
        <Step key={node.id} node={node} last={index === nodes.length - 1} state={state} />
      ))}
    </View>
  );
}
