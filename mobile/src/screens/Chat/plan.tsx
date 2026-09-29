import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ArrowUp, ClipboardList } from 'lucide-react-native';
import { useAction } from '../../lib/connection';
import { useDraft } from '../../lib/drafts';
import { Button, IconButton } from '../../ui/button';
import { Markdown } from '../../ui/Markdown';
import { backgroundImage } from '../../ui/material';
import { Text } from '../../ui/text';
import { space, useTheme } from '../../ui/theme';
import { Note } from './note';
import { AnswerField, AnswerRow, DecisionCard } from './questions';

/** The plan waiting for review, and where its decision goes. */
export type PendingPlan = { id: string; chatId: string; subChatId: string; onDecided: () => void };

// Taller plans fold to about ten lines until the reader asks for the rest.
const FOLDED_HEIGHT = 250;

function FoldedMarkdown({ text }: { text: string }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(0);
  const long = height > FOLDED_HEIGHT;
  return (
    <View style={{ gap: space.xs }}>
      <View style={{ maxHeight: open ? undefined : FOLDED_HEIGHT, overflow: 'hidden' }}>
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          <Markdown content={text} />
        </View>
        {long && !open && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: 64,
              // The card's own fill, fading in over the cut-off lines.
              ...backgroundImage(`linear-gradient(180deg, ${t.solidCard}00, ${t.solidCard})`),
            }}
          />
        )}
      </View>
      {long && (
        <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} hitSlop={8}>
          <Text variant="secondary" color="accent" style={{ fontWeight: '600' }}>
            {open ? 'Show less' : 'Show more'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/** Approve starts the build, as on the Mac; Send back replies with a note and Frink replans. */
function PlanDecision({ plan }: { plan: PendingPlan }) {
  const { id, chatId, subChatId } = plan;
  const draft = useDraft(JSON.stringify(['plan', chatId, subChatId, id]), '');
  const [writing, setWriting] = useState(!!draft.value);
  const action = useAction();
  async function decide(approve: boolean) {
    const { requestId } = draft;
    const done = await action.run(
      approve
        ? { type: 'approvePlan', chatId, subChatId, planId: id, requestId }
        : { type: 'sendMessage', chatId, subChatId, requestId, text: draft.value.trim() },
    );
    if (!done) return;
    draft.clear(requestId);
    plan.onDecided();
  }
  return (
    <>
      {writing && (
        <AnswerRow
          send={
            <IconButton
              icon={ArrowUp}
              label="Send back"
              tone="accent"
              size={36}
              disabled={!draft.value.trim() || action.busy}
              onPress={() => void decide(false)}
            />
          }
        >
          <AnswerField
            accessibilityLabel="What should change"
            placeholder="What should Frink change?"
            value={draft.value}
            onChangeText={draft.update}
            editable={!action.busy}
            autoFocus
            multiline
          />
        </AnswerRow>
      )}
      {action.error && <Note error>{action.error}</Note>}
      <View style={{ flexDirection: 'row', gap: space.sm, justifyContent: 'flex-end' }}>
        <Button
          small
          variant="secondary"
          disabled={action.busy}
          onPress={() => setWriting(!writing)}
        >
          {writing ? 'Cancel' : 'Send back'}
        </Button>
        {!writing && (
          <Button small disabled={action.busy} busy={action.busy} onPress={() => void decide(true)}>
            Approve
          </Button>
        )}
      </View>
    </>
  );
}

/** A plan Frink wrote. The one waiting for review carries its decision; earlier ones just read. */
export function PlanCard({ text, pending }: { text: string; pending?: PendingPlan }) {
  return (
    <DecisionCard
      icon={ClipboardList}
      eyebrow={pending ? 'Plan ready for your review' : 'Plan'}
      settled={!pending}
    >
      <FoldedMarkdown text={text} />
      {pending && <PlanDecision plan={pending} />}
    </DecisionCard>
  );
}
