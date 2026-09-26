import { Button } from '@benord-labs/frink-primitives';
import { X } from 'lucide-react';
import { memo, useMemo } from 'react';
import { friendlyMcpName } from '../../../../../../../shared/lib/mcp-tool-name';
import { parseRule } from '../../../../../../../shared/lib/rule-parser';
import type { RuleType } from '../../../../../../../shared/types/permissions';
import { cn } from '../../../../../../lib/utils';
import { Badge } from '../../../../../ui/badge';

type RuleBadgeProps = {
  ruleString: string;
  ruleType: RuleType;
  /** When omitted, the delete button is hidden (read-only / policy scope). */
  onDelete?: () => void;
};

const RULE_TYPE_VARIANT: Record<RuleType, 'default' | 'destructive' | 'secondary'> = {
  allow: 'secondary',
  deny: 'destructive',
  ask: 'default',
};

/**
 * Derive the display label for an MCP rule. Returns null for non-MCP rules
 * (caller falls back to the raw rule string). Wildcards (`mcp__server__*`)
 * render as "All tools"; specific tools use the snake/kebab → Title formatter.
 */
function mcpDisplay(ruleString: string): { tool: string; server: string } | null {
  const parsed = parseRule(ruleString);
  if ('error' in parsed) return null;
  if (!parsed.tool.startsWith('mcp__')) return null;
  const friendly = friendlyMcpName(parsed.tool);
  if (!friendly.server) return null;
  const tool = parsed.tool.endsWith('__*') ? 'All tools' : friendly.tool;
  return { tool, server: friendly.server };
}

export const RuleBadge = memo(function RuleBadge({
  ruleString,
  ruleType,
  onDelete,
}: RuleBadgeProps) {
  const mcp = useMemo(() => mcpDisplay(ruleString), [ruleString]);
  return (
    <div
      className={cn(
        // Fixed row height ≥ the two-line MCP variant (tool + server) so MCP
        // and single-line rules share one consistent card height.
        'group relative flex min-h-11 items-center gap-2 px-3 py-1.5',
        'transition-colors duration-150',
        'hover:bg-foreground/6',
        'before:absolute before:inset-y-1.5 before:left-0 before:w-[2px] before:rounded-r-sm',
        'before:bg-primary/0 before:transition-colors before:duration-150',
        'hover:before:bg-primary/60',
      )}
    >
      <Badge
        variant={RULE_TYPE_VARIANT[ruleType]}
        className="text-[10px] font-medium transition-opacity group-hover:opacity-90"
      >
        {ruleType}
      </Badge>
      {mcp ? (
        <div className="flex min-w-0 flex-1 flex-col leading-tight" title={ruleString}>
          <span className="truncate text-xs text-foreground/85 transition-colors group-hover:text-foreground">
            {mcp.tool}
          </span>
          <code className="truncate font-mono text-[10px] text-muted-foreground">{mcp.server}</code>
        </div>
      ) : (
        <code className="flex-1 truncate font-mono text-xs text-foreground/85 transition-colors group-hover:text-foreground">
          {ruleString}
        </code>
      )}
      {onDelete && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          aria-label={`Delete rule ${ruleString}`}
          className={cn(
            'h-6 w-6 -translate-x-1 p-0 text-muted-foreground opacity-0',
            'transition-all duration-150',
            'group-hover:translate-x-0 group-hover:opacity-100 group-hover:text-foreground',
            'hover:bg-destructive/15 hover:text-destructive',
            'focus-visible:translate-x-0 focus-visible:opacity-100',
          )}
          iconOnly
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
});
