import { memo, useCallback, useMemo } from 'react';
import {
  BASE_REQUIRED_TABS,
  buildFamilyTabs,
  type FamilyTabBucket,
} from '../../../../../../shared/lib/rule-family';
import type { PermissionsDoc, RuleType } from '../../../../../../shared/types/permissions';
import { trpc } from '../../../../../lib/trpc';
import { cn } from '../../../../../lib/utils';
import { SettingsSection } from '../../../../settings/SettingsSection';
import { Skeleton } from '../../../../ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../../ui/tabs';
import { SETTINGS_GLASS_PANEL_CLASS, SETTINGS_LIST_SHELL_CLASS } from '../../settings-tab-surface';
import { AddRuleInput } from './AddRuleInput';
import { RuleBadge } from './RuleBadge';

type ScopeSectionProps = {
  title: string;
  description: string;
  doc: PermissionsDoc | undefined;
  /** When set, the AddRuleInput targets `addProjectRule` and delete uses `removeProjectRule`. */
  projectId?: string;
  /** When true, the AddRuleInput targets `addUserRule` and delete uses `removeUserRule`. */
  userScope?: boolean;
  /** When true: no AddRuleInput, no delete buttons on RuleBadges (Policy section). */
  readOnly?: boolean;
};

export const ScopeSection = memo(function ScopeSection({
  title,
  description,
  doc,
  projectId,
  userScope,
  readOnly,
}: ScopeSectionProps) {
  // Mutation hooks live at the section level (not per-badge) — keeps Rules of Hooks
  // intact across readOnly toggling and avoids one mutation pair per rule.
  const utils = trpc.useUtils();
  const removeProjectRule = trpc.permissions.removeProjectRule.useMutation({
    onSuccess: (_, vars) => {
      utils.permissions.listProjectRules.invalidate({ projectId: vars.projectId });
    },
  });
  const removeUserRule = trpc.permissions.removeUserRule.useMutation({
    onSuccess: () => {
      utils.permissions.listUserRules.invalidate();
    },
  });

  const handleDelete = useCallback(
    (ruleString: string, ruleType: RuleType) => {
      if (readOnly) return;
      if (projectId !== undefined) {
        removeProjectRule.mutate({ projectId, ruleString, ruleType });
      } else if (userScope) {
        removeUserRule.mutate({ ruleString, ruleType });
      }
    },
    [readOnly, projectId, userScope, removeProjectRule, removeUserRule],
  );

  if (!doc) {
    return (
      <SettingsSection title={title} description={description}>
        <Skeleton className="h-12" aria-label={`Loading ${title} rules`} />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={title} description={description}>
      <div className={cn(SETTINGS_GLASS_PANEL_CLASS, 'flex flex-col gap-3')}>
        <ScopeBody doc={doc} onDelete={readOnly ? undefined : handleDelete} />
        {!readOnly && projectId !== undefined && <AddRuleInput projectId={projectId} />}
        {!readOnly && userScope && <AddRuleInput userScope />}
      </div>
    </SettingsSection>
  );
});

type ScopeBodyProps = {
  doc: PermissionsDoc;
  onDelete?: (ruleString: string, ruleType: RuleType) => void;
};

// Accepts any allow/deny/ask shape — both FamilyTabBucket and PermissionsDoc.
const bucketSize = (b: {
  allow: readonly string[];
  deny: readonly string[];
  ask: readonly string[];
}): number => b.allow.length + b.deny.length + b.ask.length;

/**
 * Renders the family-tab body. The same fixed tab row renders in every scope
 * (Bash, File ops, MCP — all servers grouped) so Project / User / Policy stay
 * identical. No tab is disabled — selecting an empty one shows a per-family
 * empty state — which keeps every tab a real, clickable affordance. A scope
 * with no rules at all → "No rules in this scope".
 */
const ScopeBody = memo(function ScopeBody({ doc, onDelete }: ScopeBodyProps) {
  // Always-on tabs may be empty, so open on the first tab that has rules.
  const { tabs, defaultTab } = useMemo(() => {
    const tabs = buildFamilyTabs(doc, BASE_REQUIRED_TABS);
    return { tabs, defaultTab: (tabs.find((t) => bucketSize(t.bucket) > 0) ?? tabs[0]).key };
  }, [doc]);
  if (bucketSize(doc) === 0) {
    return <p className="text-xs text-muted-foreground">No rules in this scope.</p>;
  }
  return (
    <Tabs defaultValue={defaultTab} className="flex flex-col gap-2">
      <TabsList className="self-start h-8 p-0.5">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.key} value={tab.key} className="text-[11px] px-2 py-1 h-7">
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent
          key={tab.key}
          value={tab.key}
          // `flex` overrides the browser default `[hidden] { display: none }`
          // for inactive panels, so radix's `hidden` attribute alone doesn't
          // hide them — they still flex-occupy layout and cumulative gaps shift
          // the visible tab's content downward. Explicit `data-[state=inactive]`
          // restores hiding.
          className="mt-0 flex flex-col gap-2 data-[state=inactive]:hidden"
        >
          <FamilyBucketView label={tab.label} bucket={tab.bucket} onDelete={onDelete} />
        </TabsContent>
      ))}
    </Tabs>
  );
});

type DeletableRuleBadgeProps = {
  ruleString: string;
  ruleType: RuleType;
  /** Stable section-level handler. Undefined → read-only render. */
  onDelete?: (ruleString: string, ruleType: RuleType) => void;
};

/**
 * Thin wrapper that binds the section-level `handleDelete` to the rule's
 * `(ruleString, ruleType)` context so `RuleBadge`'s `memo` actually skips
 * renders. Without this binding, an inline `() => handleDelete(...)` lambda
 * in the parent would create a new prop reference every render.
 */
const DeletableRuleBadge = memo(function DeletableRuleBadge({
  ruleString,
  ruleType,
  onDelete,
}: DeletableRuleBadgeProps) {
  const handleClick = useCallback(() => {
    onDelete?.(ruleString, ruleType);
  }, [onDelete, ruleString, ruleType]);

  return (
    <RuleBadge
      ruleString={ruleString}
      ruleType={ruleType}
      onDelete={onDelete ? handleClick : undefined}
    />
  );
});

type FamilyBucketViewProps = {
  label: string;
  bucket: FamilyTabBucket;
  onDelete?: (ruleString: string, ruleType: RuleType) => void;
};

const TYPE_ORDER: readonly RuleType[] = ['allow', 'deny', 'ask'];
const TYPE_HEADING: Record<RuleType, string> = {
  allow: 'Allowed',
  deny: 'Denied',
  ask: 'Asks',
};

/**
 * Renders one family tab's body — only the allow / deny / ask sub-sections
 * that actually have rules. The TYPE heading always renders for each present
 * type, so the first rule sits below a heading in every tab (vertical
 * position consistent within a family-type combo).
 */
const FamilyBucketView = memo(function FamilyBucketView({
  label,
  bucket,
  onDelete,
}: FamilyBucketViewProps) {
  const typesPresent = TYPE_ORDER.filter((t) => bucket[t].length > 0);
  if (typesPresent.length === 0) {
    return <p className="text-xs text-muted-foreground">No {label} rules in this scope.</p>;
  }
  return (
    <>
      {typesPresent.map((type) => (
        <FamilyTypeList key={type} ruleType={type} rules={bucket[type]} onDelete={onDelete} />
      ))}
    </>
  );
});

type FamilyTypeListProps = {
  ruleType: RuleType;
  rules: readonly string[];
  onDelete?: (ruleString: string, ruleType: RuleType) => void;
};

const FamilyTypeList = memo(function FamilyTypeList({
  ruleType,
  rules,
  onDelete,
}: FamilyTypeListProps) {
  if (rules.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-muted-foreground text-xs">{TYPE_HEADING[ruleType]}</span>
      <ul className={cn(SETTINGS_LIST_SHELL_CLASS, 'flex flex-col')}>
        {rules.map((ruleString) => (
          <li key={`${ruleType}:${ruleString}`}>
            <DeletableRuleBadge ruleString={ruleString} ruleType={ruleType} onDelete={onDelete} />
          </li>
        ))}
      </ul>
    </div>
  );
});

type ProjectScopeSectionProps = {
  project: { id: string; name: string };
};

/**
 * Per-project wrapper that calls `listProjectRules({projectId})` and feeds the
 * result into `ScopeSection`. Lives here (named export) instead of as a flat
 * sibling file to honour CLAUDE.md hierarchy — it's only used by
 * `AgentsPermissionsTab/index.tsx`.
 */
export const ProjectScopeSection = memo(function ProjectScopeSection({
  project,
}: ProjectScopeSectionProps) {
  const { data } = trpc.permissions.listProjectRules.useQuery({ projectId: project.id });
  return (
    <ScopeSection
      title={`Project — ${project.name}`}
      description="Rules scoped to this project."
      doc={data}
      projectId={project.id}
    />
  );
});
