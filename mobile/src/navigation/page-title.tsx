import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { Text } from '../ui/text';
import { GUTTER, space } from '../ui/theme';

const ios = Platform.OS === 'ios';

/**
 * A pushed page's name. iOS shows it in the navigation bar; the web preview's bar has no title, so
 * it gets the name as a heading in content.
 */
export function usePageTitle(title: string | undefined): ReactNode {
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({ title: ios ? (title ?? '') : '' });
  }, [navigation, title]);
  if (ios || !title) return null;
  return (
    <View style={{ paddingHorizontal: GUTTER, paddingTop: space.sm }}>
      <Text variant="largeTitle" accessibilityRole="header">
        {title}
      </Text>
    </View>
  );
}
