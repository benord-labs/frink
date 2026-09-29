import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { Text } from '../ui/text';
import { GUTTER, space } from '../ui/theme';

const ios = Platform.OS === 'ios';

/**
 * A pushed page's name as an iOS large title: big under the back button, folding into the bar as
 * you scroll. The web preview has no native large titles, so it gets the same heading in content.
 */
export function useLargeTitle(title: string | undefined): ReactNode {
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions(ios ? { title: title ?? '', headerLargeTitleEnabled: true } : { title: '' });
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
