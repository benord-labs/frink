import { useRoute, type RouteProp } from '@react-navigation/native';
import { useState } from 'react';
import { ActivityIndicator, Pressable, SectionList, View, type TextStyle } from 'react-native';
import { ChevronDown, ChevronRight, FileDiff } from 'lucide-react-native';
import type {
  MobileChangedFile,
  MobileChatChanges,
  MobileDiffLine,
} from '@frink/shared/types/remote/mobile';
import { useChatChanges } from '../../lib/changes/use-chat-changes';
import {
  changeSummary,
  emptyKind,
  fileSections,
  lineLocation,
  OMITTED_NOTE,
  omittedNote,
  toggled,
  type DiffRow,
} from '../../lib/changes/view';
import { usePageTitle } from '../../navigation/page-title';
import { useRootNavigation, type RootRoutes } from '../../navigation/routes';
import { EmptyState } from '../../ui/list';
import { confirmAction } from '../../ui/confirm';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { Text } from '../../ui/text';
import { GUTTER, space, useTheme } from '../../ui/theme';

const STATUS_WORD: Record<MobileChangedFile['status'], string | null> = {
  added: 'New',
  deleted: 'Deleted',
  renamed: 'Renamed',
  modified: null,
};
/** Diffs read at the 12pt floor so a phone fits a useful line width. */
const CODE: TextStyle = { fontSize: 12, lineHeight: 18 };
const NUMBER: TextStyle = { ...CODE, width: 36, flexShrink: 0, textAlign: 'right' };

function FileHeader({
  file,
  open,
  onToggle,
}: {
  file: MobileChangedFile;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useTheme();
  const Chevron = open ? ChevronDown : ChevronRight;
  const status = STATUS_WORD[file.status];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${file.path}, ${file.additions} added, ${file.deletions} removed`}
      accessibilityState={{ expanded: open }}
      aria-expanded={open}
      onPress={onToggle}
      style={{
        minHeight: 48,
        paddingHorizontal: GUTTER,
        paddingVertical: space.sm,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        backgroundColor: t.background,
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
      }}
    >
      <Chevron size={16} color={t.muted} />
      <Text
        variant="secondary"
        numberOfLines={2}
        ellipsizeMode="head"
        style={{ flex: 1, fontWeight: '600' }}
      >
        {file.path}
      </Text>
      {status && (
        <Text variant="label" color="muted">
          {status}
        </Text>
      )}
      <Text variant="label" color="live">
        +{file.additions}
      </Text>
      <Text variant="label" color="danger">
        −{file.deletions}
      </Text>
    </Pressable>
  );
}

function LineRow({ line, onAsk }: { line: MobileDiffLine; onAsk: () => void }) {
  const t = useTheme();
  const marker = { add: '+', del: '−', ctx: ' ' }[line.kind];
  const background = { add: t.liveSoft, del: t.dangerSoft, ctx: 'transparent' }[line.kind];
  return (
    <Pressable
      accessibilityHint="Touch and hold to ask for a change to this line."
      onLongPress={onAsk}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: space.xs,
        paddingRight: GUTTER,
        backgroundColor: pressed ? t.pressed : background,
      })}
    >
      <Text variant="mono" color="muted" style={NUMBER}>
        {line.oldNo ?? ''}
      </Text>
      <Text variant="mono" color="muted" style={NUMBER}>
        {line.newNo ?? ''}
      </Text>
      <Text variant="mono" color="muted" style={CODE}>
        {marker}
      </Text>
      <Text variant="mono" style={[CODE, { flex: 1, minWidth: 0 }]}>
        {line.text}
      </Text>
    </Pressable>
  );
}

function DiffRowView({ row, onAsk }: { row: DiffRow; onAsk: (line: MobileDiffLine) => void }) {
  const t = useTheme();
  if (row.type === 'line') return <LineRow line={row.line} onAsk={() => onAsk(row.line)} />;
  return (
    <Text
      variant="mono"
      color="muted"
      numberOfLines={1}
      style={{
        fontSize: 12,
        paddingHorizontal: GUTTER,
        paddingVertical: space.xs,
        backgroundColor: t.fill,
      }}
    >
      {row.text}
    </Text>
  );
}

/** Asks to confirm, then returns to the chat with the line named in its draft. */
function useAskForChange() {
  const navigation = useRootNavigation();
  return async (path: string, line: MobileDiffLine) => {
    const location = lineLocation(path, line);
    if (await confirmAction('Ask for a change', location, 'Ask for a change'))
      navigation.popTo('Chat', { ask: `${location} - ` }, { merge: true });
  };
}

function ChangesSummary({ changes }: { changes: MobileChatChanges | undefined }) {
  const summary = changeSummary(changes);
  return (
    <>
      {summary && (
        <Text variant="secondary" color="muted" style={{ paddingHorizontal: GUTTER }}>
          {summary}
        </Text>
      )}
      {changes?.truncated && (
        <Text variant="secondary" color="attention" style={{ paddingHorizontal: GUTTER }}>
          {OMITTED_NOTE.size}
        </Text>
      )}
    </>
  );
}

function ChangesEmpty({ kind }: { kind: ReturnType<typeof emptyKind> }) {
  const t = useTheme();
  if (kind === 'loading') return <ActivityIndicator color={t.muted} style={{ marginTop: 64 }} />;
  if (kind === 'clean')
    return (
      <EmptyState
        icon={FileDiff}
        title="No changes"
        detail="This chat has no uncommitted changes."
      />
    );
  return null;
}

function OmittedNote({ file, open }: { file: MobileChangedFile; open: boolean }) {
  const note = omittedNote(file, open);
  if (!note) return null;
  return (
    <Text
      variant="secondary"
      color="muted"
      style={{ paddingHorizontal: GUTTER, paddingVertical: space.sm }}
    >
      {note}
    </Text>
  );
}

/** What the agent changed in this chat's worktree: one collapsible section per file. */
export function ChangesScreen() {
  const { params } = useRoute<RouteProp<RootRoutes, 'Changes'>>();
  const heading = usePageTitle('Changes');
  const [revision, setRevision] = useState(0);
  const { data, error } = useChatChanges(params.chatId, { revision });
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const ask = useAskForChange();
  return (
    <Screen>
      <SectionList
        testID="changes"
        sections={fileSections(data?.files ?? [], closed)}
        keyExtractor={(row) => row.key}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 64 }}
        ListHeaderComponent={
          <View style={{ gap: space.md, paddingBottom: space.md }}>
            {heading}
            <ResourceStatus error={error} refresh={() => setRevision((v) => v + 1)} />
            <ChangesSummary changes={data} />
          </View>
        }
        ListEmptyComponent={<ChangesEmpty kind={emptyKind(data, error)} />}
        renderSectionHeader={({ section }) => (
          <FileHeader
            file={section.file}
            open={!closed.has(section.key)}
            onToggle={() => setClosed((old) => toggled(old, section.key))}
          />
        )}
        renderSectionFooter={({ section }) => (
          <OmittedNote file={section.file} open={!closed.has(section.key)} />
        )}
        renderItem={({ item, section }) => (
          <DiffRowView row={item} onAsk={(line) => void ask(section.file.path, line)} />
        )}
      />
    </Screen>
  );
}
