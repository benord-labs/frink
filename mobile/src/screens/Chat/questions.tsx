import * as Crypto from 'expo-crypto';
import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { MobilePermission, MobileQuestion } from '../../../../src/shared/types/remote/mobile';
import { useAction } from '../../lib/connection';
import { Button, Field, Label, Notice } from '../../ui/primitives';
import { useTheme } from '../../ui/theme';

// Reason: Question types and validation remain together for the MVP answer form.
// fallow-ignore-next-line complexity
export function QuestionForm({
  prompt,
  onAnswered,
}: {
  prompt: MobileQuestion;
  onAnswered: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [reply, setReply] = useState('');
  const requestId = useRef(Crypto.randomUUID());
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
      requestId: requestId.current,
    });
    if (result) onAnswered();
  }
  return (
    <View style={{ gap: 16, paddingVertical: 16 }}>
      <Label bold size={19}>
        Your answer is needed
      </Label>
      {!prompt.questions.length && (
        <>
          <Label>{prompt.title}</Label>
          <Field
            accessibilityLabel="Reply to your agent"
            placeholder="Reply to your agent…"
            value={reply}
            onChangeText={(text) => {
              requestId.current = Crypto.randomUUID();
              setReply(text);
            }}
            editable={!action.busy}
            multiline
          />
        </>
      )}
      {prompt.questions.map((q) => (
        <View key={q.question} style={{ gap: 9 }}>
          <Label bold>{q.question}</Label>
          {q.multiSelect && (
            <Label size={13} muted>
              Choose any that apply.
            </Label>
          )}
          {q.options.map(
            // Reason: Single and multiple choice rendering share the MVP option card.
            // fallow-ignore-next-line complexity
            (option) => {
              const selected = choices[q.question]?.includes(option.label) ?? false;
              return (
                <Pressable
                  key={option.label}
                  accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                  accessibilityState={{
                    checked: selected,
                    disabled: action.busy,
                  }}
                  disabled={action.busy}
                  onPress={() => {
                    requestId.current = Crypto.randomUUID();
                    setChoices(
                      // Reason: Choice toggling keeps single and multiple selection state together.
                      // fallow-ignore-next-line complexity
                      (old) => ({
                        ...old,
                        [q.question]: q.multiSelect
                          ? selected
                            ? (old[q.question] ?? []).filter((x) => x !== option.label)
                            : [...(old[q.question] ?? []), option.label]
                          : [option.label],
                      }),
                    );
                  }}
                  style={{
                    padding: 14,
                    gap: 3,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: selected ? t.accent : t.border,
                    backgroundColor: selected ? t.field : t.surface,
                    minHeight: 48,
                  }}
                >
                  <Text
                    style={{
                      color: selected ? t.accent : t.text,
                      fontSize: 16,
                      fontWeight: '500',
                    }}
                  >
                    {selected ? '✓  ' : ''}
                    {option.label}
                  </Text>
                  {!!option.description && (
                    <Label size={13} muted>
                      {option.description}
                    </Label>
                  )}
                </Pressable>
              );
            },
          )}
          <Field
            accessibilityLabel={`Custom answer: ${q.question}`}
            placeholder="Or write an answer…"
            value={custom[q.question] ?? ''}
            onChangeText={(value) => {
              requestId.current = Crypto.randomUUID();
              setCustom((old) => ({ ...old, [q.question]: value }));
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
    </View>
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
    <View style={{ gap: 12, paddingVertical: 16 }}>
      <Label size={19} bold>
        {prompt.title}
      </Label>
      <Label size={14}>{prompt.description}</Label>
      {action.error && <Notice error>{action.error}</Notice>}
      {prompt.supported ? (
        <>
          <Button disabled={action.busy} onPress={() => void respond(true)}>
            Allow once
          </Button>
          <Button secondary disabled={action.busy} onPress={() => void respond(false)}>
            Deny request
          </Button>
        </>
      ) : (
        <Notice>Review this request on your computer.</Notice>
      )}
    </View>
  );
}
