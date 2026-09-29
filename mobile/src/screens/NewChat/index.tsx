import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useResource } from '../../lib/connection';
import { useDraft } from '../../lib/drafts';
import { readPreferences, savePreferences, type NewChatPreferences } from '../../lib/preferences';
import { useRootNavigation, type RootRoutes } from '../../navigation/routes';
import { Button } from '../../ui/button';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { bareInput } from '../../ui/search-field';
import { Text } from '../../ui/text';
import { GUTTER, space, type as ramp, useTheme } from '../../ui/theme';
import { chosenProject, NOT_READY, PLAN_HELP, WORK_HELP } from './new-chat-options';
import { Note } from './note';
import { OptionChips, SendButton } from './option-chips';
import { ProjectPicker } from './project-picker';
import { useStartChat } from './use-start-chat';

// iOS lays out header buttons itself; the web preview's header needs the gutter.
const HEADER_INSET = Platform.OS === 'web' ? GUTTER : 0;

export function NewChatScreen({ route }: NativeStackScreenProps<RootRoutes, 'NewChat'>) {
  return (
    <Screen>
      <NewChat requestedProjectId={route.params?.projectId} />
    </Screen>
  );
}

/** Cancel / Back in the sheet's header, as plain accent text like iOS. */
function HeaderTextButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={12}
      style={{ paddingHorizontal: HEADER_INSET }}
    >
      <Text variant="row" color="accent" style={{ fontWeight: '400' }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The message box is the screen; project, location and mode are chips under it. */
function NewChat({ requestedProjectId }: { requestedProjectId?: string }) {
  const t = useTheme();
  const navigation = useRootNavigation();
  const projects = useResource({ type: 'projects' }, { interval: 10000 });
  const overview = useResource({ type: 'overview' }, { interval: 5000 });
  const ready = overview.data?.executionReady !== false;
  const draft = useDraft('new-chat', '');
  const [choice, setChoice] = useState<NewChatPreferences | null>(null);
  const [picking, setPicking] = useState(false);
  const chat = useStartChat();

  useEffect(() => {
    void readPreferences().then((saved) =>
      setChoice(
        (current) => current ?? { ...saved, projectId: requestedProjectId ?? saved.projectId },
      ),
    );
  }, [requestedProjectId]);

  const project = chosenProject(projects.data, choice?.projectId ?? null);
  const text = draft.value.trim();
  const canSend = ready && !!project && !!text;
  // The header button outlives this render, so it calls whichever send() is current.
  const sendLatest = useRef(send);
  sendLatest.current = send;
  // Choosing a project takes over the sheet's own header, so there is one level of navigation.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitleAlign: 'center',
      title: picking ? 'Choose a project' : 'New chat',
      headerLeft: () =>
        picking ? (
          <HeaderTextButton label="Back" onPress={() => setPicking(false)} />
        ) : (
          <HeaderTextButton label="Cancel" onPress={navigation.goBack} />
        ),
      headerRight: () =>
        picking ? null : (
          <View style={{ paddingHorizontal: HEADER_INSET }}>
            <SendButton
              enabled={canSend}
              sending={chat.starting}
              onPress={() => void sendLatest.current()}
            />
          </View>
        ),
    });
  }, [navigation, canSend, chat.starting, picking]);
  const orphan = chat.orphan;
  const select = (projectId: string) => {
    if (choice) setChoice({ ...choice, projectId });
    setPicking(false);
  };

  async function send() {
    if (!choice || !project || !text) return;
    const started = await chat.start({ ...choice, projectId: project.id }, text, draft.requestId);
    if (!started) return;
    draft.clear(draft.requestId);
    void savePreferences({ ...choice, projectId: project.id });
    navigation.replace('Chat', { id: started.chatId, subChatId: started.subChatId });
  }

  if (!choice) return <ActivityIndicator style={{ padding: 48 }} color={t.muted} />;
  if (picking)
    return (
      <ScrollView keyboardShouldPersistTaps="handled">
        <ProjectPicker
          projects={projects.data ?? []}
          selectedId={project?.id ?? null}
          onSelect={select}
        />
      </ScrollView>
    );
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={{ paddingBottom: space.xxl }}
    >
      <ResourceStatus {...projects} />
      <View style={{ paddingHorizontal: GUTTER, paddingTop: space.lg, gap: space.lg }}>
        <TextInput
          autoFocus
          multiline
          accessibilityLabel="New chat message"
          placeholder="Describe a task…"
          placeholderTextColor={t.muted}
          selectionColor={t.accent}
          value={draft.value}
          onChangeText={draft.update}
          style={[
            ramp.body,
            { color: t.text, minHeight: 132, padding: 0, textAlignVertical: 'top' },
            bareInput,
          ]}
        />
        <OptionChips
          projectName={project?.name}
          choice={choice}
          onPickProject={() => setPicking(true)}
          onChange={setChoice}
        />
        <View style={{ gap: 2 }}>
          <Text variant="secondary" color="muted">
            {WORK_HELP[choice.useWorktree ? 'worktree' : 'local']}
          </Text>
          {choice.mode === 'plan' && (
            <Text variant="secondary" color="muted">
              {PLAN_HELP}
            </Text>
          )}
        </View>
        {!ready && <Note tone="attention">{NOT_READY}</Note>}
        {ready && projects.data?.length === 0 && (
          <Note tone="attention">Add a project in Frink on your Mac to start a chat.</Note>
        )}
        {chat.error && (
          <Note tone="danger" detail={orphan ? chat.error : undefined}>
            {orphan
              ? 'Your chat was made, but the first message didn’t send. Tap send to try again, or open the chat.'
              : chat.error}
          </Note>
        )}
        {orphan && (
          <Button
            small
            variant="secondary"
            style={{ alignSelf: 'flex-start' }}
            onPress={() =>
              navigation.replace('Chat', { id: orphan.chatId, subChatId: orphan.subChatId })
            }
          >
            Open the new chat
          </Button>
        )}
      </View>
    </ScrollView>
  );
}
