import * as Crypto from 'expo-crypto';
import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { MobilePermission, MobileQuestion } from '../../../../src/shared/types/remote/mobile';
import { useAction } from '../../lib/connection';
import { Button, Field, Icon, Label, Notice } from '../../ui/primitives';
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
    <View style={{ gap: 16 }}>
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
        <View key={q.question} style={{ gap: 8 }}>
          <Label bold size={17} style={{ lineHeight: 24 }}>
            {q.question}
          </Label>
          {q.multiSelect && (
            <Label size={13} muted>
              Choose any that apply.
            </Label>
          )}
          {q.options.map(
            // Reason: Single and multiple choice rendering share the same inline selection row.
            // fallow-ignore-next-line complexity
            (option) => {
              const selected = choices[q.question]?.includes(option.label) ?? false;
              return (
                <Pressable
                  key={option.label}
                  accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={selected}
                  aria-disabled={action.busy}
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
                  style={({ pressed }) => ({
                    paddingVertical: 12,
                    gap: 12,
                    flexDirection: 'row',
                    alignItems: 'flex-start',
                    minHeight: 48,
                    opacity: pressed ? 0.7 : 1,
                    borderBottomWidth: 1,
                    borderColor: t.border,
                  })}
                >
                  <View style={{ marginTop: 1 }}>
                    <Icon
                      name={
                        q.multiSelect
                          ? selected
                            ? 'checkbox'
                            : 'square-outline'
                          : selected
                            ? 'radio-button-on'
                            : 'radio-button-off'
                      }
                      size={20}
                      color={selected ? t.accent : t.muted}
                    />
                  </View>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text
                      style={{
                        color: t.text,
                        fontSize: 15,
                        lineHeight: 21,
                        fontWeight: selected ? '600' : '400',
                      }}
                    >
                      {option.label}
                    </Text>
                    {!!option.description && (
                      <Label size={13} muted>
                        {option.description}
                      </Label>
                    )}
                  </View>
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
      <View style={{ alignItems: 'flex-start' }}>
        <Button
          compact
          onPress={() => void submit()}
          disabled={action.busy || Object.values(answers).some((answer) => !answer)}
        >
          {action.busy ? 'Sending answer…' : 'Send answer'}
        </Button>
      </View>
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
    <View style={{ gap: 16 }}>
      <Label muted size={13}>
        Permission requested
      </Label>
      <Label size={17} bold style={{ lineHeight: 24 }}>
        {prompt.title}
      </Label>
      <Label size={15} style={{ lineHeight: 23 }}>
        {prompt.description}
      </Label>
      {action.error && <Notice error>{action.error}</Notice>}
      {prompt.supported ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'flex-start',
            gap: 8,
          }}
        >
          <Button compact secondary disabled={action.busy} onPress={() => void respond(false)}>
            Deny request
          </Button>
          <Button compact disabled={action.busy} onPress={() => void respond(true)}>
            Allow once
          </Button>
        </View>
      ) : (
        <Notice>Review this request on your computer.</Notice>
      )}
    </View>
  );
}
