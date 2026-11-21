import { useLayoutEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { SearchField } from '../ui/search-field';
import { GUTTER, space } from '../ui/theme';
import { tabRootOptions } from './header-options';
import { useRootNavigation } from './routes';

const ios = Platform.OS === 'ios';

/** A tab root's large title and search; the web preview's header has no search bar, so the page does. */
export function useScreenHeader({ title, search }: { title: string; search?: string }) {
  const navigation = useRootNavigation();
  const [query, setQuery] = useState('');
  useLayoutEffect(() => {
    const field = search ? { placeholder: search, onChange: setQuery } : undefined;
    navigation.setOptions(tabRootOptions(title, field, ios));
  }, [navigation, title, search]);
  return {
    query: query.trim(),
    header:
      search && !ios ? (
        <View style={{ paddingHorizontal: GUTTER, paddingVertical: space.sm }}>
          <SearchField value={query} onChangeText={setQuery} placeholder={search} />
        </View>
      ) : null,
  };
}
