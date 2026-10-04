import { Fragment, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  ArrowRight,
  Bot,
  Box,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  CircleCheckBig,
  CircleStop,
  CornerDownRight,
  FolderOpen,
  Globe,
  Hand,
  GitBranch,
  Play,
  Reply,
  Split,
  SquareTerminal,
  Undo2,
  Webhook,
  type LucideIcon,
} from 'lucide-react-native';
import type { MobileFlowDefinition } from '@frink/shared/types/remote/mobile';
import { Markdown } from '../../../ui/Markdown';
import { EmptyState, RowSeparator } from '../../../ui/list';
import { Text } from '../../../ui/text';
import { GUTTER, radius, space, useTheme } from '../../../ui/theme';
import { outlineSteps, type OutlineLine, type OutlineStep } from '../outline';

const BLOCK_ICONS: Record<string, LucideIcon> = {
  manual_trigger: Play,
  schedule_trigger: CalendarClock,
  webhook_trigger: Webhook,
  post_task_trigger: CircleCheckBig,
  start_task: FolderOpen,
  agent: Bot,
  condition: GitBranch,
  fan_out: Split,
  run_command: SquareTerminal,
  http_request: Globe,
  approval: Hand,
  chat_reply: Reply,
  end: CircleStop,
};
const LINE_ICONS: Record<OutlineLine['kind'], LucideIcon | null> = {
  branch: CornerDownRight,
  loop: Undo2,
  jump: ArrowRight,
  note: null,
};
const TEXT_INSET = GUTTER + 20 + space.md;

function Line({ line }: { line: OutlineLine }) {
  const t = useTheme();
  const Icon = LINE_ICONS[line.kind];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
      {Icon && <Icon size={15} color={t.muted} style={{ marginTop: 3 }} />}
      <Text variant="secondary" color="muted" style={{ flex: 1 }}>
        {line.text}
        {line.target && <Text variant="secondary">{` ${line.target}`}</Text>}
      </Text>
    </View>
  );
}

function Step({ step }: { step: OutlineStep }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const instructions = step.node.instructions?.trim();
  const Chevron = open ? ChevronUp : ChevronDown;
  const Icon = BLOCK_ICONS[step.node.blockType] ?? Box;
  return (
    <View testID={`outline-step-${step.node.id}`} style={{ paddingVertical: 10, gap: space.sm }}>
      <Pressable
        disabled={!instructions}
        accessibilityRole={instructions ? 'button' : undefined}
        accessibilityLabel={
          instructions ? `${open ? 'Hide' : 'Show'} instructions for ${step.node.label}` : undefined
        }
        aria-expanded={instructions ? open : undefined}
        onPress={() => setOpen((shown) => !shown)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          paddingHorizontal: GUTTER,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon size={20} color={t.secondary} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text variant="row">{step.node.label}</Text>
          <Text variant="secondary" color="muted">
            {step.type}
          </Text>
        </View>
        {instructions && <Chevron size={18} color={t.muted} />}
      </Pressable>
      {(step.lines.length > 0 || open) && (
        <View style={{ paddingLeft: TEXT_INSET, paddingRight: GUTTER, gap: space.xs }}>
          {step.lines.map((line, index) => (
            <Line key={index} line={line} />
          ))}
          {open && instructions && (
            <View
              style={{
                marginTop: space.xs,
                paddingHorizontal: space.md,
                paddingTop: space.sm,
                paddingBottom: space.xs,
                borderRadius: radius.md,
                backgroundColor: t.fill,
              }}
            >
              <Markdown content={instructions} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

/** The saved Flow as a read-only list of steps; editing stays on the Mac. */
export function FlowOutline({ definition }: { definition: MobileFlowDefinition | null }) {
  const steps = useMemo(() => (definition ? outlineSteps(definition) : []), [definition]);
  if (!definition)
    return (
      <EmptyState
        title="Steps can’t be shown here"
        detail="This Flow may be unfinished or too large for your phone. Open it in Frink on your Mac to see every step."
      />
    );
  return (
    <View>
      {steps.map((step, index) => (
        <Fragment key={`${definition.versionNumber}:${step.node.id}`}>
          {index > 0 && <RowSeparator inset={TEXT_INSET} />}
          <Step step={step} />
        </Fragment>
      ))}
      <Text
        variant="secondary"
        color="muted"
        style={{ paddingHorizontal: GUTTER, paddingTop: space.md }}
      >
        Version {definition.versionNumber}. Change steps in Frink on your Mac.
      </Text>
    </View>
  );
}
