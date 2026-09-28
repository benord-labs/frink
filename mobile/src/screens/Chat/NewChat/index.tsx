import { useState } from 'react';
import { View } from 'react-native';
import type { MobileResponses } from '../../../../../src/shared/types/remote/mobile';
import { useAction, useResource } from '../../../lib/connection';
import { useDraft } from '../../../lib/drafts';
import { Button, CardNote, Field, Label, Loading, Notice, Row, Section } from '../../../ui/primitives';
import { Page } from '../../../ui/page';
import { SearchField } from '../../../ui/search-field';

type Project = MobileResponses['projects'][number];

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

// Reason: Project choice, name and create feedback form one short form.
// fallow-ignore-next-line complexity
export function NewChat({
  onBack,
  openChat,
}: {
  onBack: () => void;
  openChat: (id: string, subChatId?: string) => void;
}) {
  const { data: projects, error } = useResource({ type: 'projects' });
  const draft = useDraft<{ projectId: string | null; name: string }>('new-chat', {
    projectId: null,
    name: '',
  });
  const { projectId, name } = draft.value;
  const action = useAction();
  const ready =
    !!projectId && !!projects?.some((project) => project.id === projectId) && !!name.trim();
  async function create() {
    if (!projectId) return;
    const chat = await action.run({ type: 'createChat', projectId, name: name.trim() });
    if (chat) {
      draft.clear(draft.requestId);
      openChat(chat.chatId, chat.subChatId);
    }
  }
  return (
    <Page title="New chat" onBack={onBack}>
      <Label muted size={15}>
        Pick a project on your computer, then name the conversation.
      </Label>
      {(error || action.error) && <Notice error>{error || action.error}</Notice>}
      <ProjectPicker
        projects={projects}
        loading={!error}
        selected={projectId}
        onSelect={(id) => draft.update({ ...draft.value, projectId: id })}
      />
      <Section title="Name" plain>
        <Field
          accessibilityLabel="Chat name"
          placeholder="What are you working on?"
          value={name}
          onChangeText={(value) => draft.update({ ...draft.value, name: value })}
          maxLength={100}
        />
      </Section>
      <Button disabled={!ready || action.busy} onPress={() => void create()}>
        {action.busy ? 'Creating…' : 'Create chat'}
      </Button>
    </Page>
  );
}
