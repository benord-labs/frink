import { useState } from 'react';
import { ResourceStatus } from '../../../ui/resource-status';
import { SearchField } from '../../../ui/search-field';
import { useAction, useResource } from '../../../lib/connection';
import {
  Button,
  Card,
  CardNote,
  Label,
  Loading,
  Notice,
  Row,
  Section,
} from '../../../ui/primitives';
import { Page } from '../../../ui/page';
import { SwipeAction } from '../../../ui/swipe-action';
import { confirmChatDeletion } from '../delete-chat';

// Reason: Loading, empty, search and list states share one screen.
// fallow-ignore-next-line complexity
export function Chats({ openChat }: { openChat: (id: string) => void }) {
  const resource = useResource({ type: 'chats' });
  const projects = useResource({ type: 'projects' });
  const [search, setSearch] = useState('');
  const action = useAction();
  const names = new Map(projects.data?.map((project) => [project.id, project.name]));
  const needle = search.trim().toLocaleLowerCase();
  const chats = resource.data?.filter((chat) =>
    `${chat.name} ${names.get(chat.projectId ?? '') ?? ''}`.toLocaleLowerCase().includes(needle),
  );
  async function remove(id: string, name: string) {
    if (!(await confirmChatDeletion(name))) return;
    if (await action.run({ type: 'deleteChat', chatId: id })) resource.refresh();
  }
  return (
    <Page root title="Chats" refreshing={resource.refreshing} onRefresh={resource.pull}>
      <SearchField placeholder="Search conversations" value={search} onChangeText={setSearch} />
      <ResourceStatus {...resource} />
      {action.error && <Notice error>{action.error}</Notice>}
      {!chats ? (
        !resource.error && <Loading />
      ) : chats.length ? (
        <>
          <Section title="Recent conversations">
            {chats.map((chat, index) => {
              const title = chat.name || 'Untitled chat';
              return (
                <SwipeAction
                  key={chat.id}
                  label="Delete"
                  icon="trash-outline"
                  accessibilityLabel={`Delete ${title}`}
                  onPress={() => void remove(chat.id, title)}
                >
                  <Row
                    title={title}
                    subtitle={chat.projectId ? names.get(chat.projectId) : undefined}
                    separator={index < chats.length - 1}
                    onPress={() => openChat(chat.id)}
                    icon="chatbubble-outline"
                  />
                </SwipeAction>
              );
            })}
          </Section>
          <Label muted size={13} style={{ textAlign: 'center' }}>
            Swipe a chat left to delete it.
          </Label>
        </>
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
