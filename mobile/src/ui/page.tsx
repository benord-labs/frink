import type { ReactNode, Ref } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ScrollViewProps,
} from 'react-native';
import { Chrome } from './chrome';
import { GUTTER, Icon, Label } from './primitives';
import { useTheme } from './theme';

// Reason: Root, setup and detail screens share one content frame without duplicate layouts.
// fallow-ignore-next-line complexity
export function Page({
  title,
  subtitle,
  context,
  children,
  onBack,
  action,
  root = false,
  refreshing = false,
  onRefresh,
  scrollRef,
  scrollProps,
}: {
  title: string;
  subtitle?: string;
  context?: ReactNode;
  children: ReactNode;
  onBack?: () => void;
  action?: ReactNode;
  root?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  scrollRef?: Ref<ScrollView>;
  scrollProps?: ScrollViewProps;
}) {
  const t = useTheme();
  return (
    <View style={{ flex: 1 }}>
      {onBack && (
        <View
          style={{
            minHeight: 52,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 4,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderColor: t.border,
          }}
        >
          <Chrome />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go back"
            onPress={onBack}
            style={{ width: 44, height: 44, justifyContent: 'center', alignItems: 'center' }}
          >
            <Icon name="chevron-back" size={26} color={t.accent} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              maxFontSizeMultiplier={1.4}
              style={{ color: t.text, fontSize: 17, lineHeight: 22, fontWeight: '600' }}
            >
              {title}
            </Text>
            {context}
          </View>
          <View style={{ width: 44, alignItems: 'center' }}>{action}</View>
        </View>
      )}
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
        refreshControl={
          onRefresh ? (
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.accent} />
          ) : undefined
        }
        {...scrollProps}
        contentContainerStyle={{
          width: '100%',
          maxWidth: 720,
          alignSelf: 'center',
          paddingHorizontal: GUTTER,
          paddingTop: root ? 4 : 20,
          paddingBottom: 32,
          gap: 24,
        }}
      >
        {!onBack && !root && (
          <View style={{ gap: 6, paddingTop: 12 }}>
            {subtitle && (
              <Label muted size={14} bold>
                {subtitle}
              </Label>
            )}
            <Text
              accessibilityRole="header"
              style={{
                color: t.text,
                fontSize: 30,
                lineHeight: 36,
                fontWeight: '700',
                letterSpacing: -0.6,
              }}
            >
              {title}
            </Text>
          </View>
        )}
        {children}
      </ScrollView>
    </View>
  );
}
