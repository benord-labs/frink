import { useHeaderHeight } from '@react-navigation/elements';
import { useEffect, useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useResource } from '../../lib/connection';
import { useDraft } from '../../lib/drafts';
import { readPreferences, savePreferences, type NewChatPreferences } from '../../lib/preferences';
import { useRootNavigation } from '../../navigation/routes';
import { ResourceStatus } from '../../ui/resource-status';
import { Text } from '../../ui/text';
import { GUTTER, space, useTheme } from '../../ui/theme';
import { Composer, useComposerAttachments, useComposerState } from '../Chat/Composer';
import { ChipButton } from '../Chat/Composer/chip';
import { ModeMenu, ModelMenus } from '../Chat/Composer/controls';
import { MenuChip } from '../Chat/Composer/menu';
import { Sheet } from '../Chat/Composer/sheet';
import { useExecutionReady, useKeyboardShown } from '../Chat/environment';
import { useChatHeader } from '../Chat/header';
import { chosenProject, creationChoiceChanged, PLAN_HELP, WORK_HELP } from './new-chat-options';
import { ProjectPicker } from './project-picker';
import { useStartChat } from './use-start-chat';

const ios = Platform.OS === 'ios';
const mark = require('../../../assets/frink-mark.png');
const NO_PROJECTS = 'Add a project in Frink on your Mac to start a chat.';
const PLACES = [
  { id: 'worktree', label: 'Worktree' },
  { id: 'local', label: 'Local' },
];

/**
 * A new chat is a blank conversation: the same message box as any chat, with the project, where
 * it works, the mode and the model chosen in it. The chat is made on the Mac by the first message,
 * or by asking for the models, since the model list belongs to a chat.
 */
export function NewChat({ requestedProjectId }: { requestedProjectId?: string }) {
  const t = useTheme();
  const navigation = useRootNavigation();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const keyboard = useKeyboardShown();
  const projects = useResource({ type: 'projects' }, { interval: 10_000 });
  const ready = useExecutionReady();
  const draft = useDraft('new-chat', '');
  const [choice, setChoice] = useState<NewChatPreferences | null>(null);
  const [picking, setPicking] = useState(false);
  const chat = useStartChat();
  const { created } = chat;
  const settings = useComposerState(created?.chatId ?? '', created?.subChatId);
  const project = chosenProject(projects.data, choice?.projectId ?? null);
  const start = () =>
    choice && project ? chat.create({ ...choice, projectId: project.id }) : undefined;
  const attachments = useComposerAttachments(created, { retainPicked: true, ensureTarget: start });

  useChatHeader(
    { name: 'New chat', kind: undefined, project: project?.name, activity: undefined, elapsed: '' },
    null,
  );
  useEffect(() => {
    void readPreferences().then((saved) =>
      setChoice(
        (current) => current ?? { ...saved, projectId: requestedProjectId ?? saved.projectId },
      ),
    );
  }, [requestedProjectId]);
  // Leaving after only looking at the models would strand an empty chat on the Mac.
  const leave = useRef(chat.leave);
  leave.current = chat.leave;
  useEffect(() => () => leave.current(), []);

  // The project and where it works are fixed when a chat is made, so changing either starts over.
  function choose(next: NewChatPreferences) {
    // Compared by the project each choice resolves to: a saved project that no longer exists
    // shows the first one, and picking that same one again changes nothing.
    const target = chosenProject(projects.data, next.projectId);
    const shown = choice && { ...choice, projectId: project?.id ?? choice.projectId };
    if (
      creationChoiceChanged(shown, { ...next, projectId: target?.id ?? next.projectId }, !!created)
    ) {
      chat.discard();
      if (attachments.items.length && target) void chat.create({ ...next, projectId: target.id });
    }
    setChoice(next);
  }

  async function send() {
    const { requestId } = draft;
    const made = await start();
    if (!made || !choice || !project) return;
    // A model or mode picked a moment ago must be saved before the message that uses it.
    if (!(await settings.settled())) return;
    const message = { text: draft.value, requestId, attachments: attachments.ids };
    if (!(await chat.send(made, message))) return;
    draft.clear(requestId);
    void savePreferences({ ...choice, projectId: project.id });
    navigation.replace('Chat', { id: made.chatId, subChatId: made.subChatId });
  }

  const note = chat.error
    ? { text: chat.error, error: true }
    : settings.error
      ? { text: settings.error, error: true }
      : projects.data?.length === 0
        ? { text: NO_PROJECTS }
        : null;
  const busy = chat.busy;
  // A chat whose first message may have arrived keeps its project and place.
  const fixed = busy || chat.sendTried;
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={ios ? 'padding' : undefined}>
      <View
        testID="chat-transcript"
        style={{
          flex: 1,
          justifyContent: 'flex-end',
          paddingTop: ios ? headerHeight : 0,
          paddingHorizontal: 10,
          paddingBottom: keyboard ? space.sm : Math.max(insets.bottom, space.sm),
          gap: space.md,
        }}
      >
        {!keyboard && (
          <View
            style={{
              flex: 1,
              justifyContent: 'center',
              alignItems: 'center',
              gap: space.md,
              paddingHorizontal: GUTTER,
            }}
          >
            <Image
              source={mark}
              style={{ width: 32, height: 38, tintColor: t.accent }}
              resizeMode="contain"
            />
            <Text style={{ textAlign: 'center' }}>What would you like to work on?</Text>
            <Text variant="secondary" color="muted" style={{ textAlign: 'center' }}>
              Choose a project, then start a conversation.
            </Text>
          </View>
        )}
        <ResourceStatus {...projects} />
        {choice && project && (
          <View style={{ gap: space.xs, paddingHorizontal: GUTTER - 10 }}>
            <Text variant="secondary" color="muted">
              {WORK_HELP[choice.useWorktree ? 'worktree' : 'local']}
            </Text>
            {choice.mode === 'plan' && !created && (
              <Text variant="secondary" color="muted">
                {PLAN_HELP}
              </Text>
            )}
          </View>
        )}
        {choice && (
          <View testID="composer" style={{ width: '100%', maxWidth: 720, alignSelf: 'center' }}>
            <Composer
              activity="idle"
              executionReady={ready}
              flowRun={false}
              busy={busy}
              note={note}
              value={draft.value}
              onChange={draft.update}
              onSend={() => void send()}
              onStop={() => {}}
              attachments={attachments}
              onUpdate={(patch) => settings.change({ type: 'updateComposer', patch })}
              onMode={() => {}}
              inline={
                created && settings.composer ? (
                  <ModelMenus
                    composer={settings.composer}
                    disabled={busy}
                    onUpdate={(patch) => settings.change({ type: 'updateComposer', patch })}
                  />
                ) : (
                  <ChipButton
                    label="Model"
                    accessibilityLabel="Choose model"
                    disabled={busy || !!created || !project || !ready}
                    onPress={() => void start()}
                  />
                )
              }
              below={
                <>
                  <ChipButton
                    label={project?.name ?? 'Project'}
                    accessibilityLabel={project ? `Project: ${project.name}` : 'Choose project'}
                    disabled={fixed}
                    onPress={() => setPicking(true)}
                  />
                  <MenuChip
                    label={choice.useWorktree ? 'Worktree' : 'Local'}
                    accessibilityLabel={`Work in: ${choice.useWorktree ? 'Worktree' : 'Local'}`}
                    disabled={fixed}
                    groups={[
                      {
                        title: 'Work in',
                        value: choice.useWorktree ? 'worktree' : 'local',
                        options: PLACES,
                        onPick: (id) => choose({ ...choice, useWorktree: id === 'worktree' }),
                      },
                    ]}
                  />
                  <ModeMenu
                    mode={settings.composer?.mode ?? choice.mode}
                    debugAvailable={!!settings.composer?.debugAvailable}
                    // A made chat takes its mode as a saved setting, which needs its settings read.
                    disabled={busy || (!!created && !settings.composer)}
                    onMode={(mode) => {
                      if (created) settings.change({ type: 'setMode', mode });
                      if (mode !== 'debug') choose({ ...choice, mode });
                    }}
                  />
                </>
              }
            />
          </View>
        )}
      </View>
      {picking && choice && (
        <Sheet title="Project" onClose={() => setPicking(false)}>
          <ProjectPicker
            projects={projects.data ?? []}
            selectedId={project?.id ?? null}
            onSelect={(projectId) => {
              choose({ ...choice, projectId });
              setPicking(false);
            }}
          />
        </Sheet>
      )}
    </KeyboardAvoidingView>
  );
}
