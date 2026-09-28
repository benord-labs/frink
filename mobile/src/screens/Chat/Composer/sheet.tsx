import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GUTTER } from '../../../ui/primitives';
import { useTheme } from '../../../ui/theme';

/** A native page sheet for one composer choice: title, Done, and a scrolling body. */
export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: t.solidSurface }}>
        <View
          style={{
            height: 56,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderColor: t.border,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{ fontSize: 17, lineHeight: 22, fontWeight: '600', color: t.text }}
          >
            {title}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done"
            onPress={onClose}
            hitSlop={8}
            style={({ pressed }) => ({
              position: 'absolute',
              right: GUTTER,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ fontSize: 17, lineHeight: 22, fontWeight: '600', color: t.accent }}>
              Done
            </Text>
          </Pressable>
        </View>
        <ScrollView
          contentContainerStyle={{
            padding: GUTTER,
            paddingBottom: GUTTER + insets.bottom,
            gap: 20,
          }}
        >
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}
