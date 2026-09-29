import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import type { MobileResponses } from '../../../../../src/shared/types/remote/mobile';
import { useAction, useResource } from '../../../lib/connection';
import { useDraft } from '../../../lib/drafts';
import { Button, CardNote, Label, Loading, Notice, Row, Section } from '../../../ui/primitives';
import { Page } from '../../../ui/page';
import { SearchField } from '../../../ui/search-field';
import { Segmented } from '../../../ui/segmented';
import { Composer } from '../Composer';
import { recentProjectsFirst } from './recent-projects';

type Project = MobileResponses['projects'][number];
type WorkMode = 'worktree' | 'local';
/** `key` is project + work mode: a retry reuses the chat only if neither changed. */
type Created = { key: string; chatId: string; subChatId: string };

// Desktop's own words for its Local / Worktree choice.
const workModes = {
  worktree:
    'Works in a separate copy on its own branch. Your folder stays untouched until you merge.',
  local: 'Works in your project folder. Changes show up right away.',
} as const;

function WorkModePicker({
  value,
  onChange,
}: {
  value: WorkMode;
  onChange: (mode: WorkMode) => void;
}) {
  return (
    <Section title="Work in" plain>
      <Segmented
        items={[
          { id: 'worktree', label: 'Worktree' },
          { id: 'local', label: 'Local' },
        ]}
        value={value}
        onChange={onChange}
      />
      <Label muted size={13}>
        {workModes[value]}
      </Label>
    </Section>
  );
}

const noop = () => {};

// Reason: Loading, empty, no-match and list states share one project card.
// fallow-ignore-next-line complexity
function ProjectPicker({
  projects,
  loading,
  selected,
  onSelect,
}: {
  projects?: Project[];
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const needle = search.trim().toLocaleLowerCase();
  const available = projects?.filter((project) =>
    project.name.toLocaleLowerCase().includes(needle),
  );
  let body;
  if (!available) body = loading && <Loading />;
  else if (!available.length)
    body = (
      <CardNote>
        {projects?.length
          ? 'No projects match your search.'
          : 'Add a project in Frink on your computer first.'}
      </CardNote>
    );
  else
    body = available.map((project, index) => (
      <Row
        key={project.id}
        title={project.name}
        selected={selected === project.id}
        icon="folder-outline"
        tone={selected === project.id ? 'accent' : 'neutral'}
        separator={index < available.length - 1}
        onPress={() => onSelect(project.id)}
      />
    ));
  return (
    <View style={{ gap: 12 }}>
      {(projects?.length ?? 0) > 5 && (
        <SearchField placeholder="Search projects" value={search} onChangeText={setSearch} />
      )}
      <Section title="Project">{body}</Section>
    </View>
  );
}

// Reason: Project choice, the first message and create/send feedback form one short screen.
// fallow-ignore-next-line complexity
export function NewChat({
  onBack,
  openChat,
}: {
  onBack: () => void;
  openChat: (id: string, subChatId?: string) => void;
}) {
  const { data: projects, error } = useResource({ type: 'projects' });
  const { data: chats } = useResource({ type: 'chats' });
  const draft = useDraft<{ projectId: string | null; text: string }>('new-chat', {
    projectId: null,
    text: '',
  });
  // Kept for the rest of the session, so the choice sticks from one new chat to the next.
  const mode = useDraft<WorkMode>('new-chat-work-mode', 'worktree');
  // A chat created on an earlier attempt whose first message did not send; retrying reuses it.
  const [created, setCreated] = useState<Created | null>(null);
  const [starting, setStarting] = useState(false);
  const action = useAction();
  const ordered = projects && recentProjectsFirst(projects, chats?.items);
  // Until the user picks one, the project they chatted in last is already selected.
  const picked = ordered?.find((project) => project.id === draft.value.projectId);
  const project = picked ?? ordered?.[0];
  async function chatFor(projectId: string): Promise<Created | undefined> {
    const key = `${projectId}:${mode.value}`;
    if (created?.key === key) return created;
    const made = await action.run({
      type: 'createChat',
      projectId,
      useWorktree: mode.value === 'worktree',
    });
    if (!made) return undefined;
    const chat = { key, ...made };
    setCreated(chat);
    return chat;
  }
  async function start(projectId: string) {
    setStarting(true);
    try {
      const chat = await chatFor(projectId);
      const sent =
        chat &&
        (await action.run({
          type: 'sendMessage',
          chatId: chat.chatId,
          subChatId: chat.subChatId,
          text: draft.value.text,
          requestId: draft.requestId,
        }));
      if (!sent) return;
      draft.clear(draft.requestId);
      openChat(chat.chatId, chat.subChatId);
    } finally {
      setStarting(false);
    }
  }
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Page title="New chat" onBack={onBack}>
        <Label muted size={15}>
          Say what you want to work on. Frink names the chat from your first message.
        </Label>
        {(error || action.error) && <Notice error>{error || action.error}</Notice>}
        {created && action.error && !starting && (
          <Button
            secondary
            icon="chatbubble-outline"
            onPress={() => openChat(created.chatId, created.subChatId)}
          >
            Open the new chat
          </Button>
        )}
        <ProjectPicker
          projects={ordered}
          loading={!error}
          selected={project?.id ?? null}
          onSelect={(id) => draft.update({ ...draft.value, projectId: id })}
        />
        <WorkModePicker value={mode.value} onChange={mode.update} />
      </Page>
      <Composer
        active={false}
        busy={starting}
        ready={!!project}
        value={draft.value.text}
        onChange={(text) => draft.update({ ...draft.value, text })}
        onSend={() => project && void start(project.id)}
        confirmStop={false}
        setConfirmStop={noop}
        onStop={noop}
        onUpdate={noop}
        onMode={noop}
        onAccount={noop}
      />
    </KeyboardAvoidingView>
  );
}
