import { Button, Input } from '@benord-labs/frink-primitives';
import { memo, useState } from 'react';
import { validateRuleString } from '../../../../../../../shared/lib/validate-rule';
import type { RuleType } from '../../../../../../../shared/types/permissions';
import { trpc } from '../../../../../../lib/trpc';
import { cn } from '../../../../../../lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../../ui/select';

type AddRuleInputProps =
  | { projectId: string; userScope?: never }
  | { projectId?: never; userScope: true };

const RULE_TYPES: RuleType[] = ['allow', 'deny', 'ask'];

/**
 * Normalize Windows-style path separators (`src\foo.ts`) → POSIX (`src/foo.ts`)
 * before persisting the rule. The matcher (`rule-matcher.ts:matchPathContent`)
 * already normalizes the target path; mirror that here so the stored rule
 * stays in canonical form. Preserve `\(` and `\)` escape sequences (per
 * `rule-parser.ts` grammar — parens in content must be escaped).
 */
function normalizeRuleSeparators(rule: string): string {
  return rule.includes('\\') ? rule.replace(/\\(?![()])/g, '/') : rule;
}

export const AddRuleInput = memo(function AddRuleInput(props: AddRuleInputProps) {
  const [ruleString, setRuleString] = useState('');
  const [ruleType, setRuleType] = useState<RuleType>('allow');
  const [error, setError] = useState<string | null>(null);

  const utils = trpc.useUtils();

  const addProjectRule = trpc.permissions.addProjectRule.useMutation({
    onSuccess: (result, vars) => {
      if (result.ok) {
        utils.permissions.listProjectRules.invalidate({ projectId: vars.projectId });
      }
    },
  });
  const addUserRule = trpc.permissions.addUserRule.useMutation({
    onSuccess: (result) => {
      if (result.ok) {
        utils.permissions.listUserRules.invalidate();
      }
    },
  });

  const isSubmitting = addProjectRule.isPending || addUserRule.isPending;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeRuleSeparators(ruleString.trim());
    if (!normalized) return;

    // Client-side validation: surface bad tool names / typos immediately,
    // skipping the round-trip. Server validates the same input as
    // defense-in-depth (the renderer is untrusted by the main process).
    const validation = validateRuleString(normalized, ruleType);
    if (!validation.ok) {
      setError(validation.message);
      return;
    }

    setError(null);
    const result = props.userScope
      ? await addUserRule.mutateAsync({ ruleString: normalized, ruleType })
      : await addProjectRule.mutateAsync({
          projectId: props.projectId,
          ruleString: normalized,
          ruleType,
        });

    if (result.ok) {
      setRuleString('');
    } else {
      setError(result.message);
    }
  };

  const handleBlur = () => {
    const normalized = normalizeRuleSeparators(ruleString.trim());
    if (!normalized) {
      setError(null);
      return;
    }
    const validation = validateRuleString(normalized, ruleType);
    setError(validation.ok ? null : validation.message);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          value={ruleString}
          onChange={(e) => {
            setRuleString(e.target.value);
            // Clear stale error while user is typing; revalidates on blur/submit.
            if (error) setError(null);
          }}
          onBlur={handleBlur}
          placeholder="e.g. Read, Write, Bash(npm:*)"
          size="sm"
          className={cn(
            'flex-1 font-mono text-xs',
            'border-border/40 bg-background/40 backdrop-blur-xs',
            'focus-visible:bg-background/60',
          )}
          aria-label="Rule string"
          aria-invalid={error !== null}
        />
        <Select
          value={ruleType}
          onValueChange={(v) => {
            const nextType = v as RuleType;
            setRuleType(nextType);
            // Re-validate against the new ruleType so deny → allow flips
            // (or vice versa) on a required-tool rule update the error inline.
            const normalized = normalizeRuleSeparators(ruleString.trim());
            if (!normalized) {
              setError(null);
              return;
            }
            const validation = validateRuleString(normalized, nextType);
            setError(validation.ok ? null : validation.message);
          }}
        >
          <SelectTrigger className="h-8 w-24" aria-label="Rule type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RULE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={isSubmitting || ruleString.trim().length === 0}
          className="h-8"
        >
          Add
        </Button>
      </div>
      {error ? (
        <p className="text-[10px] text-destructive" role="alert">
          {error}
        </p>
      ) : (
        <p className="text-[10px] text-muted-foreground">
          Tool-wide (<code className="font-mono">Read</code>,{' '}
          <code className="font-mono">Write</code>) or with content (
          <code className="font-mono">Bash(npm:*)</code>,{' '}
          <code className="font-mono">Edit(src/**)</code>). Tool names are case-sensitive. See{' '}
          <a
            href="https://github.com/benord-labs/frink/blob/main/user-docs/permissions.md"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            permissions docs
          </a>
          .
        </p>
      )}
    </form>
  );
});
