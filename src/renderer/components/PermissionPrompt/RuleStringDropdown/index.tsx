import { memo, useMemo } from 'react';
import { friendlyMcpName } from '../../../../shared/lib/mcp-tool-name';
import { escapeRuleContent, parseRule } from '../../../../shared/lib/rule-parser';
import { vendorPluginMcpTitle } from '../../dialogs/settings-tabs/AgentsMcpTab/constants';
import type { PromptData } from '../../../../shared/types/permissions';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';

type RuleStringDropdownProps = {
  prompt: PromptData;
  rawInput: string;
  value: string;
  onChange: (value: string) => void;
};

/** Build a v2 fallback rule when the dispatcher didn't supply `suggestedRules`. */
export function buildFallbackRule(tool: string, input: string): string {
  // Multi-line commands (heredocs whose base was suppressed, e.g. `bash <<EOF`)
  // make terrible exact rules — the body changes every run and a mid-string
  // `:*` corrupts the rule. Collapse to the first line instead. Single-line
  // input is unchanged.
  const firstLine = input.includes('\n') ? input.slice(0, input.indexOf('\n')) : input;
  const escaped = escapeRuleContent(firstLine.trim());
  return tool === 'Bash' ? `Bash(${escaped}:*)` : `${tool}(${escaped})`;
}

function ruleLabel(prompt: PromptData, rule: string): string {
  if (prompt.tool.endsWith('__frink_flows_patch')) {
    return rule === prompt.tool ? 'Flow changes' : 'All Frink tools';
  }
  const parsed = parseRule(rule);
  if ('error' in parsed || parsed.content !== undefined) return rule;
  const name = friendlyMcpName(parsed.tool);
  const plugin = name.server ? vendorPluginMcpTitle(name.server) : null;
  return plugin ? `${plugin} · ${name.tool === '*' ? 'All tools' : name.tool}` : rule;
}

export const RuleStringDropdown = memo(function RuleStringDropdown({
  prompt,
  rawInput,
  value,
  onChange,
}: RuleStringDropdownProps) {
  const options = useMemo(() => {
    const suggested = prompt.suggestedRules;
    if (suggested && suggested.length > 0) return suggested;
    return [buildFallbackRule(prompt.tool, rawInput)];
  }, [prompt.suggestedRules, prompt.tool, rawInput]);

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className="h-7 text-xs [&>span]:truncate"
        aria-label="Permission rule"
        aria-description={value}
        title={value}
      >
        <SelectValue />
      </SelectTrigger>
      {/* z-110: lift above the z-100 permission card (App.tsx) — the Select
          portals to <body>, so its z-50 base would otherwise sit behind the card. */}
      <SelectContent className="z-110">
        {options.map((rule) => (
          <SelectItem
            key={rule}
            value={rule}
            className="text-xs"
            title={rule}
            aria-description={rule}
          >
            {ruleLabel(prompt, rule) !== rule ? (
              <span>{ruleLabel(prompt, rule)}</span>
            ) : (
              <code className="font-mono">{ruleLabel(prompt, rule)}</code>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});
