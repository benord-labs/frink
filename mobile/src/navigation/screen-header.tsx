import { useLayoutEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { SearchField } from '../ui/search-field';
import { Text } from '../ui/text';
import { GUTTER, space } from '../ui/theme';
import { useRootNavigation } from './routes';

/** The stack owns the title and Back; optional search stays visible within the list. */
export function useScreenHeader({
  title,
  eyebrow,
  search,
}: {
  title: string;
  eyebrow?: ReactNode;
  search?: string;
}) {
  const navigation = useRootNavigation();
  const [query, setQuery] = useState('');
  useLayoutEffect(() => {
    navigation.setOptions({
      title,
      headerTitle: () => (
        <View style={{ alignItems: 'center', gap: 1 }}>
          <Text variant="headline" accessibilityRole="header" maxFontSizeMultiplier={1.2}>
            {title}
          </Text>
          {eyebrow}
        </View>
      ),
    });
  }, [navigation, title, eyebrow]);
  return {
    query: query.trim(),
    header: search ? (
      <View style={{ paddingHorizontal: GUTTER, paddingVertical: space.sm }}>
        <SearchField value={query} onChangeText={setQuery} placeholder={search} />
      </View>
    ) : null,
  };
}
