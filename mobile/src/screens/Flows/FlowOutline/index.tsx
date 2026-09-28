import { useMemo, useState, type ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { findBackEdges } from '../../../../../src/shared/lib/flow-graph-cycle';
import { FLOW_BLOCK_DISPLAY_LABELS } from '../../../../../src/shared/lib/flow-block-display-labels';
import type { MobileFlowDefinition } from '../../../../../src/shared/types/remote/mobile';
import { Markdown } from '../../../ui/Markdown';
import { Card, CardNote, Icon, IconTile, Label, ROW_INSET } from '../../../ui/primitives';
import { useTheme } from '../../../ui/theme';

type DefinitionNode = MobileFlowDefinition['nodes'][number];
type DefinitionEdge = MobileFlowDefinition['edges'][number];

const nodeIcons: Record<string, ComponentProps<typeof Icon>['name']> = {
  manual_trigger: 'play-outline',
  schedule_trigger: 'calendar-outline',
  webhook_trigger: 'link-outline',
  post_task_trigger: 'checkmark-done-outline',
  start_task: 'folder-open-outline',
  agent: 'sparkles-outline',
  condition: 'git-branch-outline',
  fan_out: 'git-network-outline',
  run_command: 'terminal-outline',
  http_request: 'globe-outline',
  approval: 'hand-left-outline',
};

// Reason: Loop, named-branch and plain-next labels are one small decision table.
// fallow-ignore-next-line complexity
function branchLabel(edge: DefinitionEdge, loop: boolean): string {
  const label = edge.label || (edge.sourceHandle ? `If ${edge.sourceHandle}` : null);
  return loop ? `${label ? `${label} · ` : ''}Returns to` : label ? `${label}:` : 'Next';
}

// Reason: Branch, join, loop and nesting lines for one step render together.
// fallow-ignore-next-line complexity
function DefinitionStep({
  node,
  definition,
  loops,
  last,
}: {
  node: DefinitionNode;
  definition: MobileFlowDefinition;
  loops: Set<string>;
  last: boolean;
}) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(false);
  const outgoing = definition.edges.filter((edge) => edge.source === node.id);
  const incoming = definition.edges.filter(
    (edge) => edge.target === node.id && !loops.has(edge.id),
  );
  const nameFor = (id: string) => definition.nodes.find((entry) => entry.id === id)?.label ?? id;
  const instructions = node.instructions?.trim();
  const summary = (
    <>
      <IconTile name={nodeIcons[node.blockType] ?? 'cube-outline'} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Label size={16} style={{ fontWeight: '500' }}>
          {node.label}
        </Label>
        <Label size={14} muted>
          {FLOW_BLOCK_DISPLAY_LABELS[node.blockType as keyof typeof FLOW_BLOCK_DISPLAY_LABELS] ??
            node.blockType.replaceAll('_', ' ')}
          {instructions ? ' · Instructions' : ''}
        </Label>
      </View>
      {instructions && (
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={t.muted} />
      )}
    </>
  );
  const headerStyle = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
  };
  return (
    <View
      testID={`definition-step-${node.id}`}
      style={{
        padding: ROW_INSET,
        gap: 8,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderColor: t.border,
      }}
    >
      {instructions ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? 'Hide' : 'Show'} instructions for ${node.label}`}
          accessibilityState={{ expanded }}
          aria-expanded={expanded}
          onPress={() => setExpanded(!expanded)}
          style={({ pressed }) => [headerStyle, { opacity: pressed ? 0.65 : 1 }]}
        >
          {summary}
        </Pressable>
      ) : (
        <View style={headerStyle}>{summary}</View>
      )}
      <View style={{ paddingLeft: 42, gap: 6 }}>
        {node.parentId && (
          <Label size={14} muted>
            Inside {nameFor(node.parentId)}
          </Label>
        )}
        {incoming.length > 1 && (
          <Label size={14} muted>
            Joins from {incoming.map((edge) => nameFor(edge.source)).join(' · ')}
          </Label>
        )}
        {outgoing.map((edge) => (
          <View key={edge.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
            <View style={{ paddingTop: 3 }}>
              <Icon
                name={loops.has(edge.id) ? 'return-up-back-outline' : 'arrow-forward-outline'}
                size={14}
                color={loops.has(edge.id) ? t.warning : t.muted}
              />
            </View>
            <Text style={{ flex: 1, color: t.text, fontSize: 14, lineHeight: 20 }}>
              <Text style={{ color: t.muted }}>{branchLabel(edge, loops.has(edge.id))} </Text>
              {nameFor(edge.target)}
            </Text>
          </View>
        ))}
        {!outgoing.length && (
          <Label size={14} muted>
            {incoming.length || node.parentId ? 'End of this path' : 'Not connected'}
          </Label>
        )}
        {expanded && instructions && (
          <View
            style={{
              marginTop: 6,
              paddingTop: 12,
              paddingHorizontal: 12,
              borderRadius: 10,
              backgroundColor: t.fill,
            }}
          >
            <Markdown content={instructions} />
          </View>
        )}
      </View>
    </View>
  );
}

// Reason: Available and unavailable definitions share one card.
// fallow-ignore-next-line complexity
export function FlowOutline({ definition }: { definition?: MobileFlowDefinition | null }) {
  const loops = useMemo(
    () => (definition ? findBackEdges(definition) : new Set<string>()),
    [definition],
  );
  const t = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <View style={{ paddingHorizontal: 4, gap: 2 }}>
        <Text
          accessibilityRole="header"
          style={{ color: t.secondary, fontSize: 15, lineHeight: 20, fontWeight: '600' }}
        >
          How it runs
        </Text>
        {definition && (
          <Label size={14} muted>
            Current definition · Version {definition.versionNumber} · {definition.nodes.length}{' '}
            {definition.nodes.length === 1 ? 'step' : 'steps'}
          </Label>
        )}
      </View>
      <Card>
        {!definition ? (
          <CardNote>
            This Flow can’t be shown on your phone. It may be unfinished or too large. Open it on
            your computer to see every step.
          </CardNote>
        ) : (
          definition.nodes.map((node, index) => (
            <DefinitionStep
              key={`${definition.versionNumber}:${node.id}`}
              node={node}
              definition={definition}
              loops={loops}
              last={index === definition.nodes.length - 1}
            />
          ))
        )}
      </Card>
      {definition && (
        <Label size={14} muted style={{ paddingHorizontal: 4 }}>
          Edit steps and connections on your computer.
        </Label>
      )}
    </View>
  );
}
