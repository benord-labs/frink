import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import type { StatusGlyph as GlyphName, StatusTone } from '../../../lib/status';
import { StatusGlyph } from '../../../ui/glyphs';
import { Text } from '../../../ui/text';
import { space, useTheme } from '../../../ui/theme';
import { TOOL_STATE_WORD, toolLabel, toolRunSummary, type Tool } from './parts';

const GLYPH: Record<Tool['state'], { glyph: GlyphName; tone: StatusTone }> = {
  running: { glyph: 'live', tone: 'accent' },
  completed: { glyph: 'done', tone: 'quiet' },
  failed: { glyph: 'failed', tone: 'danger' },
  interrupted: { glyph: 'cancelled', tone: 'quiet' },
  unknown: { glyph: 'never', tone: 'quiet' },
};
const SUMMARY_GLYPH = {
  running: GLYPH.running,
  done: GLYPH.completed,
  failed: GLYPH.failed,
  stopped: GLYPH.interrupted,
} as const;

function ToolLine({ tool }: { tool: Tool }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 28 }}>
      <StatusGlyph {...GLYPH[tool.state]} size={14} />
      <Text variant="secondary" numberOfLines={1} style={{ flexShrink: 1 }}>
        {toolLabel(tool.name)}
      </Text>
      <Text variant="secondary" color="muted">
        {TOOL_STATE_WORD[tool.state]}
      </Text>
    </View>
  );
}

/** A run of tool steps as one quiet line ("Worked · 6 steps") that opens to the step list. */
export function ToolRun({ tools }: { tools: Tool[] }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const summary = toolRunSummary(tools);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View style={{ gap: 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={summary.label}
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        onPress={() => setOpen((value) => !value)}
        hitSlop={{ top: 6, bottom: 6 }}
        style={({ pressed }) => ({
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          minHeight: 32,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <StatusGlyph {...SUMMARY_GLYPH[summary.state]} size={15} />
        <Text
          variant="secondary"
          color={
            summary.state === 'running' ? 'accent' : summary.state === 'failed' ? 'danger' : 'muted'
          }
          style={{ fontWeight: '500' }}
        >
          {summary.label}
        </Text>
        <Chevron size={15} color={t.muted} strokeWidth={2} />
      </Pressable>
      {open && (
        <View
          style={{
            marginLeft: 7,
            paddingLeft: space.md + 3,
            borderLeftWidth: 1,
            borderColor: t.border,
            paddingVertical: space.xs,
          }}
        >
          {tools.map((tool) => (
            <ToolLine key={tool.id} tool={tool} />
          ))}
        </View>
      )}
    </View>
  );
}
