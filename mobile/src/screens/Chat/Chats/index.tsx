import { useState } from 'react';
import { ResourceStatus } from '../../../ui/resource-status';
import { SearchField } from '../../../ui/search-field';
import { useResource } from '../../../lib/connection';
import { Button, Card, CardNote, Loading, Row, Section } from '../../../ui/primitives';
import { Page } from '../../../ui/page';

// Reason: Loading, empty, search and list states share one screen.
// fallow-ignore-next-line complexity
export function Chats({ openChat }: { openChat: (id: string) => void }) {
  const resource = useResource({ type: 'chats' });
  const projects = useResource({ type: 'projects' });
  const [search, setSearch] = useState('');
  const names = new Map(projects.data?.map((project) => [project.id, project.name]));
  const needle = search.trim().toLocaleLowerCase();
  const chats = resource.data?.filter((chat) =>
    `${chat.name} ${names.get(chat.projectId ?? '') ?? ''}`.toLocaleLowerCase().includes(needle),
  );
  return (
    <Page root title="Chats" refreshing={resource.refreshing} onRefresh={resource.pull}>
      <SearchField placeholder="Search conversations" value={search} onChangeText={setSearch} />
      <ResourceStatus {...resource} />
      {!chats ? (
        !resource.error && <Loading />
      ) : chats.length ? (
        <Section title="Recent conversations">
          {chats.map((chat, index) => (
            <Row
              key={chat.id}
              title={chat.name || 'Untitled chat'}
              subtitle={chat.projectId ? names.get(chat.projectId) : undefined}
              separator={index < chats.length - 1}
              onPress={() => openChat(chat.id)}
              icon="chatbubble-outline"
            />
          ))}
        </Section>
      ) : (
        <Card>
          <CardNote>
            {needle
              ? 'No recent chats match your search.'
              : 'No conversations yet. Tap + to start one.'}
          </CardNote>
        </Card>
      )}
      {resource.error && (
        <Button compact secondary onPress={resource.refresh}>
          Refresh chats
        </Button>
      )}
    </Page>
  );
}
