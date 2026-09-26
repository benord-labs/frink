/**
 * Inheritance-aware project field for flow node configs.
 * Uses NodeInheritableField for Override / Reset UX; ProjectSelector for picking.
 */

import { Button, Input } from '@benord-labs/frink-primitives';
import { FolderOpen } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import type { SelectedProject } from '../../../../agents/atoms';
import { ProjectSelector } from '../../../../agents/ProjectSelector';
import { NodeInheritableField } from '../NodeInheritableField';
import { isProjectRow } from '../shared';
import { ModeToggle } from '../TemplatableField';

type NodeProjectFieldProps = {
  projectId: string;
  flowDefaultProjectId: string | undefined;
  onProjectIdChange: (id: string) => void;
  /** Opens flow settings focused on the Project field — shown when nothing is inherited. */
  onOpenFlowSettings?: () => void;
  /** Off for blocks whose dispatcher reads projectId statically, so the editor cannot offer a
   *  template the runtime would ignore. */
  allowTemplate?: boolean;
};

export function NodeProjectField({
  projectId,
  flowDefaultProjectId,
  onProjectIdChange,
  onOpenFlowSettings,
  allowTemplate = true,
}: NodeProjectFieldProps): ReactElement {
  const { data: allProjects } = trpc.projects.list.useQuery();

  const startsTemplate = projectId.includes('{{');
  const [useVariable, setUseVariable] = useState(startsTemplate);
  const expression = allowTemplate && (useVariable || startsTemplate);

  const hasOverride = projectId.trim() !== '';
  const flowDefault = flowDefaultProjectId?.trim() ?? '';
  const isInherited = !hasOverride && flowDefault !== '';

  const inheritedProjectName = useMemo((): string => {
    if (!isInherited || !flowDefaultProjectId) return '';
    const list = Array.isArray(allProjects) ? allProjects : [];
    const found = list.find((p) => isProjectRow(p) && p.id === flowDefaultProjectId);
    if (found && isProjectRow(found)) return found.name;
    return `${flowDefaultProjectId.slice(0, 8)}…`;
  }, [isInherited, flowDefaultProjectId, allProjects]);

  const overrideProject = useMemo((): SelectedProject => {
    if (!hasOverride) return null;
    const list = Array.isArray(allProjects) ? allProjects : [];
    const found = list.find((p) => isProjectRow(p) && p.id === projectId);
    if (found && isProjectRow(found)) return { id: found.id, name: found.name, path: found.path };
    return { id: projectId, name: `${projectId.slice(0, 8)}…`, path: '' };
  }, [hasOverride, allProjects, projectId]);

  const handleProjectChange = (project: SelectedProject): void => {
    onProjectIdChange(project?.id?.trim() ?? '');
  };

  // Nothing inherited and nothing picked: teach the flow-level default instead of
  // letting the user fix the same warning node-by-node.
  const showFlowDefaultCta = onOpenFlowSettings !== undefined && !hasOverride && !isInherited;

  return (
    <div className="min-w-0 space-y-1.5">
      <NodeInheritableField
        value={projectId}
        flowDefault={flowDefaultProjectId}
        icon={<FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />}
        inheritedLabel={inheritedProjectName}
        onReset={() => {
          setUseVariable(false);
          onProjectIdChange('');
        }}
        renderPicker={({ hasOverride: pickerOverride }) => (
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="min-w-0 flex-1">
              {expression ? (
                <Input
                  value={projectId}
                  placeholder="{{trigger.project}}"
                  aria-label="Project variable"
                  onChange={(e) => onProjectIdChange(e.target.value)}
                />
              ) : (
                <ProjectSelector
                  overrideProject={pickerOverride ? overrideProject : null}
                  onOverrideProjectChange={handleProjectChange}
                />
              )}
            </div>
            {allowTemplate ? (
              <ModeToggle
                active={expression}
                onClick={() => {
                  setUseVariable(!expression);
                  if (expression && startsTemplate) onProjectIdChange('');
                }}
              />
            ) : null}
          </div>
        )}
      />
      {showFlowDefaultCta ? (
        <Button
          variant="ghost"
          onClick={onOpenFlowSettings}
          className="h-auto p-0 text-xs font-normal text-muted-foreground hover:text-foreground"
        >
          Or set a flow default project
        </Button>
      ) : null}
    </div>
  );
}
