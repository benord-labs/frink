import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MobilePermission, MobileQuestion } from '../../../../src/shared/types/remote/mobile';
import { useAction } from '../../lib/connection';
import { useDraft } from '../../lib/drafts';
import {
  Button,
  Card,
  Field,
  Icon,
  IconTile,
  Label,
  Notice,
  ROW_INSET,
  type Tone,
} from '../../ui/primitives';

function DecisionHeader({
  icon,
  tone,
  label,
}: {
  icon: 'help' | 'shield-checkmark';
  tone: Tone;
  label: string;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <IconTile name={icon} tone={tone} />
      <Label size={14} bold muted>
        {label}
      </Label>
    </View>
  );
}
import { useTheme } from '../../ui/theme';

type Option = MobileQuestion['questions'][number]['options'][number];

function toggleChoice(current: string[], label: string, multiSelect: boolean, selected: boolean) {
  if (!multiSelect) return [label];
  return selected ? current.filter((choice) => choice !== label) : [...current, label];
}

function choiceIcon(multiSelect: boolean, selected: boolean) {
  if (multiSelect) return selected ? 'checkbox' : 'square-outline';
  return selected ? 'radio-button-on' : 'radio-button-off';
}

// Reason: Single and multiple choice share one selection row.
// fallow-ignore-next-line complexity
function OptionRow({
  option,
  multiSelect,
  first,
  selected,
  disabled,
  onToggle,
}: {
  option: Option;
  multiSelect: boolean;
  first: boolean;
  selected: boolean;
  disabled: boolean;
  onToggle: (selected: boolean) => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole={multiSelect ? 'checkbox' : 'radio'}
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => onToggle(selected)}
      style={({ pressed }) => ({
        paddingVertical: 12,
        paddingHorizontal: 12,
        gap: 12,
        flexDirection: 'row',
        alignItems: 'flex-start',
        minHeight: 48,
        backgroundColor: selected ? t.accentSoft : pressed ? t.fill : 'transparent',
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderColor: t.border,
      })}
    >
      <View style={{ marginTop: 1 }}>
        <Icon
          name={choiceIcon(multiSelect, selected)}
          size={20}
          color={selected ? t.accent : t.muted}
        />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={{
            color: t.text,
            fontSize: 16,
            lineHeight: 22,
            fontWeight: selected ? '600' : '500',
          }}
        >
          {option.label}
        </Text>
        {!!option.description && (
          <Label size={14} muted>
            {option.description}
          </Label>
        )}
      </View>
    </Pressable>
  );
}

// Reason: Question types and validation remain together for the MVP answer form.
// fallow-ignore-next-line complexity
export function QuestionForm({
  prompt,
  onAnswered,
}: {
  prompt: MobileQuestion;
  onAnswered: () => void;
}) {
  const draft = useDraft<{
    choices: Record<string, string[]>;
    custom: Record<string, string>;
    reply: string;
  }>(JSON.stringify(['question', prompt.chatId, prompt.subChatId, prompt.source, prompt.id]), {
    choices: {},
    custom: {},
    reply: '',
  });
  const { choices, custom, reply } = draft.value;
  const action = useAction();
  const t = useTheme();
  const answers = prompt.questions.length
    ? Object.fromEntries(
        prompt.questions.map((q) => [
          q.question,
          [...(choices[q.question] ?? []), custom[q.question]?.trim()].filter(Boolean).join(', '),
        ]),
      )
    : { reply: reply.trim() };
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
  return (
    <Card style={{ padding: ROW_INSET, gap: 16 }}>
      <DecisionHeader icon="help" tone="accent" label="Frink needs your answer" />
      {!prompt.questions.length && (
        <>
          <Label size={17} bold style={{ lineHeight: 24 }}>
            {prompt.title}
          </Label>
          <Field
            accessibilityLabel="Reply to your agent"
            placeholder="Reply to your agent…"
            value={reply}
            onChangeText={(text) => {
              draft.update({ ...draft.value, reply: text });
            }}
            editable={!action.busy}
            multiline
          />
        </>
      )}
      {prompt.questions.map((q) => (
        <View key={q.question} style={{ gap: 12 }}>
          <View style={{ gap: 4 }}>
            <Label bold size={17} style={{ lineHeight: 24 }}>
              {q.question}
            </Label>
            {q.multiSelect && (
              <Label size={14} muted>
                Choose any that apply.
              </Label>
            )}
          </View>
          <View
            style={{
              borderRadius: 12,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: t.border,
              overflow: 'hidden',
            }}
          >
            {q.options.map((option, index) => (
              <OptionRow
                key={option.label}
                option={option}
                multiSelect={q.multiSelect}
                first={index === 0}
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
          <Field
            accessibilityLabel={`Custom answer: ${q.question}`}
            placeholder="Or write an answer…"
            value={custom[q.question] ?? ''}
            onChangeText={(value) => {
              draft.update({
                ...draft.value,
                custom: { ...custom, [q.question]: value },
              });
            }}
            multiline
            editable={!action.busy}
          />
        </View>
      ))}
      {action.error && <Notice error>{action.error}</Notice>}
      <Button
        onPress={() => void submit()}
        disabled={action.busy || Object.values(answers).some((answer) => !answer)}
      >
        {action.busy ? 'Sending answer…' : 'Send answer'}
      </Button>
    </Card>
  );
}

export function PermissionForm({
  prompt,
  onAnswered,
}: {
  prompt: MobilePermission;
  onAnswered: () => void;
}) {
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
    <Card style={{ padding: ROW_INSET, gap: 16 }}>
      <DecisionHeader icon="shield-checkmark" tone="warning" label="Permission requested" />
      <View style={{ gap: 6 }}>
        <Label size={17} bold style={{ lineHeight: 24 }}>
          {prompt.title}
        </Label>
        <Label size={15} style={{ lineHeight: 22 }} muted>
          {prompt.description}
        </Label>
      </View>
      {action.error && <Notice error>{action.error}</Notice>}
      {prompt.supported ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            secondary
            disabled={action.busy}
            onPress={() => void respond(false)}
            style={{ flex: 1 }}
          >
            Deny request
          </Button>
          <Button disabled={action.busy} onPress={() => void respond(true)} style={{ flex: 1 }}>
            Allow once
          </Button>
        </View>
      ) : (
        <Notice>Review this request on your computer.</Notice>
      )}
    </Card>
  );
}
