import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, useState, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SquarePen } from 'lucide-react-native';
import { IconButton } from '../ui/button';
import { SearchField } from '../ui/search-field';
import { Text } from '../ui/text';
import { GUTTER, space } from '../ui/theme';
import { useRootNavigation } from './routes';

const native = Platform.OS === 'ios';

/**
 * A tab root's title, search and compose button. iOS gets them in the native large-title header
 * (Liquid Glass buttons, the system search bar); web renders the same pieces as the list header.
 * Returns the query and the element to place at the top of the list (null on iOS).
 */
export function useTabHeader({
  title,
  eyebrow,
  search,
  compose = false,
  composeDisabled = false,
}: {
  title: string;
  eyebrow?: ReactNode;
  search?: string;
  compose?: boolean;
  /** Keeps the button visible but inert, e.g. while the Mac can't run chats. */
  composeDisabled?: boolean;
}): { query: string; header: ReactNode } {
  const navigation = useNavigation();
  const root = useRootNavigation();
  const [query, setQuery] = useState('');
  const newChat = () => root.navigate('NewChat');
  useLayoutEffect(() => {
    if (!native) return;
    navigation.setOptions({
      headerSearchBarOptions: search
        ? {
            placeholder: search,
            hideWhenScrolling: true,
            onChangeText: (event: { nativeEvent: { text: string } }) =>
              setQuery(event.nativeEvent.text),
            onCancelButtonPress: () => setQuery(''),
          }
        : undefined,
      unstable_headerRightItems: compose
        ? () => [
            {
              type: 'button',
              label: 'New chat',
              icon: { type: 'sfSymbol', name: 'square.and.pencil' },
              disabled: composeDisabled,
              onPress: newChat,
            },
          ]
        : undefined,
    });
  });
  if (native) return { query: query.trim(), header: null };
  return {
    query: query.trim(),
    header: (
      <WebHeader
        title={title}
        eyebrow={eyebrow}
        search={search}
        query={query}
        onQuery={setQuery}
        onCompose={compose ? newChat : undefined}
        composeDisabled={composeDisabled}
      />
    ),
  };
}

function WebHeader({
  title,
  eyebrow,
  search,
  query,
  onQuery,
  onCompose,
  composeDisabled,
}: {
  title: string;
  eyebrow?: ReactNode;
  search?: string;
  query: string;
  onQuery: (value: string) => void;
  onCompose?: () => void;
  composeDisabled?: boolean;
}) {
  // Below the status bar and Dynamic Island, where iOS puts a large title.
  const { top } = useSafeAreaInsets();
  return (
    <View style={{ paddingHorizontal: GUTTER, paddingTop: top + space.md, gap: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
        <View style={{ flex: 1, gap: 2 }}>
          {eyebrow}
          <Text variant="largeTitle" accessibilityRole="header">
            {title}
          </Text>
        </View>
        {onCompose && (
          <IconButton
            icon={SquarePen}
            label="New chat"
            onPress={onCompose}
            disabled={composeDisabled}
            size={40}
          />
        )}
      </View>
      {search && <SearchField value={query} onChangeText={onQuery} placeholder={search} />}
    </View>
  );
}
