import { useMemo, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { Notice } from '../primitives';
import { useTheme, type Theme } from '../theme';
import { safeWebLink, sanitizeMarkdown } from './sanitize';

function markdownStyle(t: Theme) {
  const body = {
    color: t.text,
    fontSize: 16,
    lineHeight: 24,
    marginTop: 0,
    marginBottom: 12,
  };
  return {
    paragraph: body,
    h1: {
      ...body,
      fontSize: 22,
      lineHeight: 29,
      fontWeight: '600',
      marginTop: 16,
    },
    h2: {
      ...body,
      fontSize: 20,
      lineHeight: 27,
      fontWeight: '600',
      marginTop: 16,
    },
    h3: {
      ...body,
      fontSize: 18,
      lineHeight: 25,
      fontWeight: '600',
      marginTop: 12,
    },
    h4: { ...body, fontSize: 17, fontWeight: '600' },
    h5: { ...body, fontSize: 16, fontWeight: '600' },
    h6: { ...body, fontSize: 16, fontWeight: '600' },
    list: {
      ...body,
      bulletColor: t.muted,
      markerColor: t.muted,
      gapWidth: 8,
      itemSpacing: 5,
    },
    link: { color: t.accent, underline: true },
    strong: { color: t.text },
    code: {
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 14,
      color: t.text,
      backgroundColor: t.solidField,
    },
    codeBlock: {
      ...body,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 14,
      lineHeight: 20,
      backgroundColor: t.solidField,
      borderColor: t.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 12,
    },
    blockquote: {
      ...body,
      color: t.secondary,
      borderColor: t.border,
      borderWidth: 1,
      gapWidth: 12,
    },
    table: {
      ...body,
      fontSize: 14,
      borderColor: t.border,
      borderWidth: 1,
      headerBackgroundColor: t.solidField,
      headerTextColor: t.text,
      rowEvenBackgroundColor: t.background,
      rowOddBackgroundColor: t.background,
      cellPaddingHorizontal: 10,
      cellPaddingVertical: 8,
    },
    thematicBreak: {
      color: t.border,
      height: 1,
      marginTop: 12,
      marginBottom: 12,
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
      {error && <Notice error>{error}</Notice>}
    </View>
  );
}
