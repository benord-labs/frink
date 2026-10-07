import { Button } from '@benord-labs/frink-primitives';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PATH_TOOLS, type PromptData } from '../../../../shared/types/permissions';
import type { ApprovalDecision, PermissionRequest } from '../../../hooks/usePermissionPrompts';
import { cn } from '../../../lib/utils';
import { DenyReasonBanner } from '../DenyReasonBanner';
import { buildFallbackRule } from '../RuleStringDropdown';
import { PromptActions } from './PromptActions';
import { PromptBody } from './PromptBody';

type FourButtonViewProps = {
  request: PermissionRequest & { prompt: PromptData };
  onApprove: (decision: ApprovalDecision) => void;
  onDeny: () => void;
  primaryCtaClassName?: string;
  paneLinkAccentClass?: string;
};

/**
 * Renders the v2 permission prompt. Branches on tool type:
 *
 * - **File-op tools** (Read / Edit / Write / Delete / MultiEdit / NotebookEdit
 *   — see `PATH_TOOLS` in `src/shared/types/permissions.ts`): 3-button row
 *   `Deny / Allow this time / Allow {tool} for {project}`. The third button
 *   persists a tool-wide project-scope rule (just `Read`, `Edit`, etc. — no path
 *   content), and only renders when actionable. No rule-string dropdown —
 *   tool-wide is the only shape; power users add path rules via Settings.
 *
 * - **Everything else** (Bash, MCP, generic): `<PromptActions>` renders a
 *   vertical list — primary `Allow this time`, then "Always allow <rule ▾>" with
 *   `In this project` / `On this machine`, then a compact `Deny`. Body rendering
 *   (header label + command block) is extracted to `<PromptBody>`.
 */
export const FourButtonView = memo(function FourButtonView({
  request,
  onApprove,
  onDeny,
  primaryCtaClassName,
  paneLinkAccentClass,
}: FourButtonViewProps) {
  const prompt = request.prompt;
  const isFileOpTool = PATH_TOOLS.has(prompt.tool);
  const isBash = request.operation === 'bash';
  const trimmedProjectName = request.projectName?.trim() ?? '';
  const projectDisplayName = trimmedProjectName ? trimmedProjectName : 'this project';
  const hasProject = !!request.projectPath;
  const isPathInCurrentProject = prompt.pathLocation === 'in-current-project';
  // A saved rule cannot silence a hook, so a hook's card offers no persistent approval.
  const canPersist = !prompt.hookAsk;
  const canPersistFileOp = canPersist && isFileOpTool && hasProject && isPathInCurrentProject;

  // For file-op tools the rule is always tool-wide (just `Read`, `Edit`, etc.).
  // For Bash / MCP / other we fall back to the existing dropdown-driven behavior.
  const defaultRule = useMemo(() => {
    if (isFileOpTool) return prompt.tool;
    const suggested = prompt.suggestedRules;
    if (suggested && suggested.length > 0) return suggested[0];
    // MCP-prefix guard: `buildFallbackRule(mcp__server__tool, '')` produces
    // `mcp__server__tool()` (empty content) which `parseRule` rejects → the
    // rule silently drops at `persist-approved-rule.ts:49`. Pass the raw tool
    // name through so the fallback is at least parseable. Triggers only when
    // `checkMcp` fails to emit `suggestedRules` (malformed name).
    if (prompt.tool.startsWith('mcp__')) return prompt.tool;
    return buildFallbackRule(prompt.tool, request.path);
  }, [isFileOpTool, prompt.tool, prompt.suggestedRules, request.path]);

  // An empty (not absent) suggestion list is the dispatcher saying no rule can
  // express this command, so a fabricated fallback would never match on replay.
  const canPersistRule = canPersist && (!isBash || prompt.suggestedRules?.length !== 0);

  const [selectedRule, setSelectedRule] = useState(defaultRule);

  // Reset selection when the request changes (queue cycling) or tool branch flips.
  useEffect(() => {
    setSelectedRule(defaultRule);
  }, [defaultRule]);

  const handleApproveOnce = useCallback(() => onApprove({}), [onApprove]);
  const handleApproveProject = useCallback(
    () => onApprove({ scope: 'project', ruleString: selectedRule, ruleType: 'allow' }),
    [onApprove, selectedRule],
  );
  const handleApproveMachine = useCallback(
    () => onApprove({ scope: 'user', ruleString: selectedRule, ruleType: 'allow' }),
    [onApprove, selectedRule],
  );

  // Keyboard:
  //   Enter  → primary action. For Bash / MCP / generic that's the
  //            least-permissive "Allow this time" (research: the fastest click
  //            should not grant a persistent rule — claude-code#36258). File-op
  //            keeps its persist primary (no machine option there).
  //   Escape → Deny.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement) {
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
        if (target.getAttribute('role') === 'combobox') return;
        // A focused button handles Enter natively — let it, so the global
        // default doesn't fire a second onApprove on top of the click.
        if (target.tagName === 'BUTTON') return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        if (isFileOpTool && canPersistFileOp) handleApproveProject();
        else handleApproveOnce();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onDeny();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isFileOpTool, canPersistFileOp, handleApproveProject, handleApproveOnce, onDeny]);

  return (
    <>
      <PromptBody
        prompt={prompt}
        isBash={isBash}
        isFileOpTool={isFileOpTool}
        isPathInCurrentProject={isPathInCurrentProject}
        projectDisplayName={projectDisplayName}
        requestPath={request.path}
        paneLinkAccentClass={paneLinkAccentClass}
      />

      <DenyReasonBanner prompt={prompt} />

      {/* File-op tools persist a tool-wide rule via the single button below; the
          rule-string dropdown adds no value there. Bash / MCP / generic get
          <PromptActions> — a vertical list where the rule reads as the object
          of the "Always allow" action. */}
      {isFileOpTool ? (
        <div className="flex items-center justify-end gap-1.5 flex-wrap">
          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={onDeny}>
            Deny
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={handleApproveOnce}
          >
            Allow this time
          </Button>
          {/* Persistent button only renders when actionable. A disabled
              primary-styled button for outside / no-project paths reads as a
              "primary CTA you can't click" — hide instead. */}
          {canPersistFileOp && (
            <Button
              variant="primary"
              size="sm"
              className={cn('h-7 px-2.5 text-xs', primaryCtaClassName)}
              onClick={handleApproveProject}
            >
              Allow {prompt.tool} for {projectDisplayName}
            </Button>
          )}
        </div>
      ) : (
        <PromptActions
          prompt={prompt}
          rawInput={request.path}
          selectedRule={selectedRule}
          onChange={setSelectedRule}
          hasProject={hasProject}
          canPersistRule={canPersistRule}
          primaryCtaClassName={primaryCtaClassName}
          onDeny={onDeny}
          onApproveOnce={handleApproveOnce}
          onApproveProject={handleApproveProject}
          onApproveMachine={handleApproveMachine}
        />
      )}
    </>
  );
});
