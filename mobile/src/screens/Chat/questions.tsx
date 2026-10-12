import { useState, type ReactNode } from 'react';
import { Pressable, TextInput, View, type TextInputProps } from 'react-native';
import {
  ArrowUp,
  Circle,
  CircleCheck,
  CircleQuestionMark,
  ShieldAlert,
  Square,
  SquareCheck,
  type LucideIcon,
} from 'lucide-react-native';
import type { MobilePermission, MobileQuestion } from '@frink/shared/types/remote/mobile';
import { useAction } from '../../lib/connection';
import { useDraft } from '../../lib/drafts';
import { Button, IconButton } from '../../ui/button';
import { Text } from '../../ui/text';
import { radius, space, type as ramp, useTheme } from '../../ui/theme';
import { bareInput } from './Composer';
import { Note } from './note';

/** "#RRGGBB" at an opacity, so a state colour can tint a rim without a second palette entry. */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16},${(value >> 8) & 255},${value & 255},${alpha})`;
}

/** An inline request that waits on the reader: amber rim, amber eyebrow, then the question.
 *  `settled` draws the same card without the amber, for one that no longer waits. */
export function DecisionCard({
  icon: Icon,
  eyebrow,
  settled = false,
  children,
}: {
  icon: LucideIcon;
  eyebrow: string;
  settled?: boolean;
  children: ReactNode;
}) {
  const t = useTheme();
  const tint = settled ? t.muted : t.attention;
  return (
    <View
      style={{
        paddingHorizontal: space.md + 2,
        paddingVertical: space.md,
        gap: space.md,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: settled ? t.borderSubtle : withAlpha(t.attention, t.dark ? 0.32 : 0.3),
        backgroundColor: t.solidCard,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Icon size={14} color={tint} strokeWidth={2.2} />
        <Text variant="label" color={settled ? 'muted' : 'attention'}>
          {eyebrow}
        </Text>
      </View>
      {children}
    </View>
  );
}

const CLAMP_LINES = 4;
const LONG_PROMPT = 180;

/** The question itself: body-sized, and a long one folds to four lines with Show more. */
function PromptText({ children }: { children: string }) {
  const [open, setOpen] = useState(false);
  const long = children.length > LONG_PROMPT;
  return (
    <View style={{ gap: space.xs }}>
      <Text variant="row" numberOfLines={long && !open ? CLAMP_LINES : undefined}>
        {children}
      </Text>
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

export function AnswerField(props: TextInputProps) {
  const t = useTheme();
  return (
    <TextInput
      placeholderTextColor={t.muted}
      selectionColor={t.accent}
      maxFontSizeMultiplier={2}
      {...props}
      style={[
        ramp.secondary,
        {
          flex: 1,
          minHeight: 40,
          maxHeight: 120,
          borderRadius: radius.md,
          paddingHorizontal: space.md,
          paddingVertical: 10,
          color: t.text,
          backgroundColor: t.fill,
          borderWidth: 1,
          borderColor: t.borderSubtle,
          textAlignVertical: props.multiline ? 'top' : 'center',
        },
        bareInput,
        props.style,
      ]}
    />
  );
}

type Option = MobileQuestion['questions'][number]['options'][number];
type Answers = { choices: Record<string, string[]>; custom: Record<string, string>; reply: string };

function toggleChoice(current: string[], label: string, multiSelect: boolean, selected: boolean) {
  if (!multiSelect) return [label];
  return selected ? current.filter((choice) => choice !== label) : [...current, label];
}

function choiceIcon(multiSelect: boolean, selected: boolean) {
  if (multiSelect) return selected ? SquareCheck : Square;
  return selected ? CircleCheck : Circle;
}

function OptionRow({
  option,
  multiSelect,
  selected,
  disabled,
  onToggle,
}: {
  option: Option;
  multiSelect: boolean;
  selected: boolean;
  disabled: boolean;
  onToggle: (selected: boolean) => void;
}) {
  const t = useTheme();
  const Icon = choiceIcon(multiSelect, selected);
  return (
    <Pressable
      accessibilityRole={multiSelect ? 'checkbox' : 'radio'}
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => onToggle(selected)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        minHeight: 44,
        paddingHorizontal: 10,
        paddingVertical: space.sm,
        borderRadius: radius.md,
        backgroundColor: selected ? t.accentSoft : pressed ? t.pressed : 'transparent',
      })}
    >
      <View style={{ paddingTop: 1 }}>
        <Icon size={18} color={selected ? t.accent : t.muted} strokeWidth={2} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text variant="secondary" style={{ fontWeight: '600' }}>
          {option.label}
        </Text>
        {!!option.description && (
          <Text variant="secondary" color="muted" numberOfLines={2}>
            {option.description}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function answersFor(prompt: MobileQuestion, { choices, custom, reply }: Answers) {
  if (!prompt.questions.length) return { reply: reply.trim() };
  return Object.fromEntries(
    prompt.questions.map((q) => [
      q.question,
      [...(choices[q.question] ?? []), custom[q.question]?.trim()].filter(Boolean).join(', '),
    ]),
  );
}

/** A question from Frink, answered inline. Unsent choices survive leaving the chat. */
export function QuestionForm({
  prompt,
  onAnswered,
}: {
  prompt: MobileQuestion;
  onAnswered: () => void;
}) {
  const draft = useDraft<Answers>(
    JSON.stringify(['question', prompt.chatId, prompt.subChatId, prompt.source, prompt.id]),
    { choices: {}, custom: {}, reply: '' },
  );
  const { choices, custom, reply } = draft.value;
  const action = useAction();
  const answers = answersFor(prompt, draft.value);
  async function submit() {
    const result = await action.run({
      type: 'answerQuestion',
      id: prompt.id,
      source: prompt.source,
      chatId: prompt.chatId,
      subChatId: prompt.subChatId,
      answers,
      requestId: draft.requestId,
    });
    if (result) {
      draft.clear(draft.requestId);
      onAnswered();
    }
  }
  const ready = Object.values(answers).every(Boolean);
  const send = (
    <IconButton
      icon={ArrowUp}
      label="Send answer"
      tone="accent"
      size={36}
      disabled={!ready || action.busy}
      onPress={() => void submit()}
    />
  );
  const last = prompt.questions.length - 1;
  return (
    <DecisionCard icon={CircleQuestionMark} eyebrow="Frink needs your answer">
      {!prompt.questions.length && (
        <>
          <PromptText>{prompt.title}</PromptText>
          <AnswerRow send={send}>
            <AnswerField
              accessibilityLabel="Reply to your agent"
              placeholder="Write your answer"
              value={reply}
              onChangeText={(text) => draft.update({ ...draft.value, reply: text })}
              editable={!action.busy}
              multiline
            />
          </AnswerRow>
        </>
      )}
      {prompt.questions.map((q, index) => (
        <View key={q.question} style={{ gap: space.sm }}>
          <PromptText>{q.question}</PromptText>
          {q.multiSelect && (
            <Text variant="secondary" color="muted">
              Choose any that apply.
            </Text>
          )}
          <View style={{ gap: 2, marginHorizontal: -4 }}>
            {q.options.map((option) => (
              <OptionRow
                key={option.label}
                option={option}
                multiSelect={q.multiSelect}
                selected={choices[q.question]?.includes(option.label) ?? false}
                disabled={action.busy}
                onToggle={(selected) =>
                  draft.update({
                    ...draft.value,
                    choices: {
                      ...choices,
                      [q.question]: toggleChoice(
                        choices[q.question] ?? [],
                        option.label,
                        q.multiSelect,
                        selected,
                      ),
                    },
                  })
                }
              />
            ))}
          </View>
          <AnswerRow send={index === last ? send : null}>
            <AnswerField
              accessibilityLabel={`Custom answer: ${q.question}`}
              placeholder="Or write your own"
              value={custom[q.question] ?? ''}
              onChangeText={(value) =>
                draft.update({ ...draft.value, custom: { ...custom, [q.question]: value } })
              }
              multiline
              editable={!action.busy}
            />
          </AnswerRow>
        </View>
      ))}
      {action.error && <Note error>{action.error}</Note>}
    </DecisionCard>
  );
}

/** A reply field with the send arrow beside it, as in the message box. */
export function AnswerRow({ children, send }: { children: ReactNode; send: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
      {children}
      {send && <View style={{ paddingBottom: 2 }}>{send}</View>}
    </View>
  );
}

/** A permission Frink asked for, e.g. to run a command. Some kinds can only be answered on the Mac. */
export function PermissionForm({
  prompt,
  onAnswered,
}: {
  prompt: MobilePermission;
  onAnswered: () => void;
}) {
  const t = useTheme();
  const action = useAction();
  async function respond(approved: boolean) {
    if (
      await action.run({
        type: 'respondPermission',
        requestId: prompt.requestId,
        chatId: prompt.chatId,
        subChatId: prompt.subChatId,
        approved,
      })
    )
      onAnswered();
  }
  return (
    <DecisionCard icon={ShieldAlert} eyebrow="Frink is asking permission">
      <View style={{ gap: space.sm }}>
        <PromptText>{prompt.title}</PromptText>
        {!!prompt.description && (
          <View
            style={{
              borderRadius: radius.md,
              backgroundColor: t.fill,
              paddingHorizontal: space.md,
              paddingVertical: 10,
            }}
          >
            <Text variant="mono" color="secondary" selectable numberOfLines={4}>
              {prompt.description}
            </Text>
          </View>
        )}
      </View>
      {action.error && <Note error>{action.error}</Note>}
      {prompt.supported ? (
        <View style={{ flexDirection: 'row', gap: space.sm, justifyContent: 'flex-end' }}>
          <Button
            small
            variant="secondary"
            disabled={action.busy}
            onPress={() => void respond(false)}
          >
            Deny
          </Button>
          <Button small busy={action.busy} onPress={() => void respond(true)}>
            Allow once
          </Button>
        </View>
      ) : (
        <Note>Answer this one in Frink on your Mac.</Note>
      )}
    </DecisionCard>
  );
}
