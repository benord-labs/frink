import type { ReactElement } from 'react';
import { LoadingState } from '../../../../components/ui/loading-state';
import { trpc } from '../../../../lib/trpc';
import { cn } from '../../../../lib/utils';
import { SETTINGS_PANEL_MUTED_CLASS, SETTINGS_TAB_PAGE_CLASS } from '../settings-tab-surface';
import { PermissionsHeader } from './PermissionsHeader';
import { ProjectScopeSection, ScopeSection } from './ScopeSection';
import { SystemDeniedPathsCard } from './SystemDeniedPathsCard';

export function AgentsPermissionsTab(): ReactElement {
  const policyDoc = trpc.permissions.getPolicyDoc.useQuery();
  const userDoc = trpc.permissions.listUserRules.useQuery();
  const projects = trpc.projects.list.useQuery();
  const systemDeniedPaths = trpc.permissions.getSystemDeniedPaths.useQuery();
  const systemWriteDeniedPaths = trpc.permissions.getSystemWriteDeniedPaths.useQuery();

  const isLoading =
    policyDoc.isLoading ||
    userDoc.isLoading ||
    projects.isLoading ||
    systemDeniedPaths.isLoading ||
    systemWriteDeniedPaths.isLoading;

  if (isLoading) {
    return (
      <div className={SETTINGS_TAB_PAGE_CLASS}>
        <PermissionsHeader />
        <LoadingState
          message="Loading permissions..."
          className={cn(SETTINGS_PANEL_MUTED_CLASS, 'py-8')}
        />
      </div>
    );
  }

  return (
    <div className={SETTINGS_TAB_PAGE_CLASS}>
      <PermissionsHeader />
      <ScopeSection
        title="Policy"
        description="Read-only rules from the managed permissions file."
        doc={policyDoc.data}
        readOnly
      />
      {projects.data?.map((project) => (
        <ProjectScopeSection key={project.id} project={project} />
      ))}
      <ScopeSection
        title="User"
        description="Rules that apply across all projects on this machine."
        doc={userDoc.data}
        userScope
      />
      <SystemDeniedPathsCard
        paths={systemDeniedPaths.data ?? []}
        writePaths={systemWriteDeniedPaths.data ?? []}
      />
      <div className="h-px shrink-0" />
    </div>
  );
}
