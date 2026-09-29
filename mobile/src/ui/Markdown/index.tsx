import { useMemo, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { Text } from '../text';
import { useTheme, type Theme } from '../theme';
import { safeWebLink, sanitizeMarkdown } from './sanitize';

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// Sizes come from the app's type ramp (22/17/16/14): no 13, 11 or 10pt, even inside markdown.
function markdownStyle(t: Theme) {
  const body = {
    color: t.text,
    fontSize: 16,
    lineHeight: 25,
    marginTop: 0,
    marginBottom: 14,
  };
  const heading = { ...body, fontWeight: '600', marginTop: 10, marginBottom: 8 };
  return {
    paragraph: body,
    h1: { ...heading, fontSize: 22, lineHeight: 28, fontWeight: '700' },
    h2: { ...heading, fontSize: 17, lineHeight: 24 },
    h3: { ...heading, fontSize: 16, lineHeight: 24 },
    h4: { ...heading, fontSize: 16, lineHeight: 24 },
    h5: { ...heading, fontSize: 16, lineHeight: 24 },
    h6: { ...heading, fontSize: 16, lineHeight: 24, color: t.secondary },
    list: {
      ...body,
      bulletColor: t.muted,
      markerColor: t.muted,
      gapWidth: 10,
      itemSpacing: 6,
    },
    link: { color: t.accent, underline: false },
    strong: { color: t.text },
    code: {
      fontFamily: MONO,
      fontSize: 14,
      color: t.text,
      backgroundColor: t.fill,
      borderColor: t.borderSubtle,
    },
    codeBlock: {
      ...body,
      fontFamily: MONO,
      fontSize: 14,
      lineHeight: 21,
      color: t.secondary,
      backgroundColor: t.fill,
      borderColor: t.borderSubtle,
      borderWidth: 1,
      borderRadius: 12,
      padding: 14,
    },
    blockquote: {
      ...body,
      color: t.secondary,
      borderColor: t.border,
      borderWidth: 2,
      gapWidth: 12,
    },
    table: {
      ...body,
      fontSize: 14,
      lineHeight: 20,
      borderColor: t.border,
      borderWidth: 1,
      headerBackgroundColor: t.fill,
      headerTextColor: t.text,
      rowEvenBackgroundColor: 'transparent',
      rowOddBackgroundColor: 'transparent',
      cellPaddingHorizontal: 10,
      cellPaddingVertical: 8,
    },
    thematicBreak: {
      color: t.border,
      height: 1,
      marginTop: 14,
      marginBottom: 14,
    },
  };
}

export function Markdown({ content }: { content: string }) {
  const t = useTheme();
  const [error, setError] = useState<string | null>(null);
  const markdown = useMemo(() => sanitizeMarkdown(content), [content]);
  async function openLink({ url }: { url: string }) {
    if (!safeWebLink(url)) return;
    try {
      await Linking.openURL(url);
      setError(null);
    } catch {
      setError('Could not open this link. Copy it and open it in your browser.');
    }
  }
  return (
    <View style={{ minWidth: 0, gap: 8 }}>
      <EnrichedMarkdownText
        markdown={markdown}
        flavor="github"
        selectable
        allowFontScaling
        enableLinkPreview={false}
        enableTaskListItemToggle={false}
        md4cFlags={{ latexMath: false }}
        onLinkPress={(event) => void openLink(event)}
        onLinkLongPress={() => undefined}
        selectionColor={t.accent}
        markdownStyle={markdownStyle(t)}
      />
      {error && (
        <Text variant="secondary" color="danger">
          {error}
        </Text>
      )}
    </View>
  );
}
