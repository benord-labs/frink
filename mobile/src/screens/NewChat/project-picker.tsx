import { Fragment, useState } from 'react';
import { View } from 'react-native';
import { Check, Folder, SearchX } from 'lucide-react-native';
import type { MobileProject } from '@frink/shared/types/remote/mobile';
import { shortAge } from '../../lib/status';
import { EmptyState, ListRow, RowSeparator } from '../../ui/list';
import { SearchField } from '../../ui/search-field';
import { Text } from '../../ui/text';
import { GUTTER, radius, space, useTheme } from '../../ui/theme';
import { filterProjects, PROJECT_SEARCH_THRESHOLD } from './new-chat-options';

function ProjectTile() {
  const t = useTheme();
  return (
    <View
      style={{
        width: 38,
        height: 38,
        borderRadius: radius.md,
        backgroundColor: t.fill,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Folder size={18} color={t.secondary} strokeWidth={1.9} />
    </View>
  );
}

/** A project, with a check when it is the chosen one and otherwise when it was last used. */
function ProjectRow({
  project,
  selected = false,
  onPress,
}: {
  project: MobileProject;
  selected?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <ListRow
      leading={<ProjectTile />}
      title={project.name}
      accessibilityLabel={selected ? `${project.name}, chosen` : project.name}
      trailing={
        selected ? (
          <Check size={20} color={t.accent} strokeWidth={2.4} />
        ) : (
          <Text variant="secondary" color="muted">
            {shortAge(project.lastActiveAt)}
          </Text>
        )
      }
      onPress={onPress}
    />
  );
}

function ProjectList({
  projects,
  selectedId,
  onSelect,
}: {
  projects: MobileProject[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
}) {
  return projects.map((project, index) => (
    <Fragment key={project.id}>
      {index > 0 && <RowSeparator />}
      <ProjectRow
        project={project}
        selected={project.id === selectedId}
        onPress={() => onSelect(project.id)}
      />
    </Fragment>
  ));
}

/** The full list, most recent first, swapped in place of the message box while choosing. The
 *  sheet's header carries the title and the way back. */
export function ProjectPicker({
  projects,
  selectedId,
  onSelect,
}: {
  projects: MobileProject[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const shown = filterProjects(projects, query);
  return (
    <View style={{ paddingTop: space.sm, paddingBottom: space.xl }}>
      {projects.length > PROJECT_SEARCH_THRESHOLD && (
        <View style={{ paddingHorizontal: GUTTER, paddingBottom: space.sm }}>
          <SearchField value={query} onChangeText={setQuery} placeholder="Search projects" />
        </View>
      )}
      <ProjectList projects={shown} selectedId={selectedId} onSelect={onSelect} />
      {!shown.length && (
        <EmptyState
          icon={SearchX}
          title={projects.length ? 'No projects match' : 'No projects yet'}
          detail={
            projects.length
              ? 'Try another name.'
              : 'Add a project in Frink on your Mac, then start a chat here.'
          }
        />
      )}
    </View>
  );
}
