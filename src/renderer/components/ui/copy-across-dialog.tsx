import { Button } from '@benord-labs/frink-primitives';
import { Globe, Laptop } from 'lucide-react';
import { memo, type ReactElement, useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

type Project = { id: string; name: string; path: string };
type CopyMode = 'portable' | 'native';
type Tool = 'claude-code' | 'cursor';

const TOOL_LABEL: Record<Tool, string> = { 'claude-code': 'Claude', cursor: 'Cursor' };

type Props = {
  /** The resource(s) to copy — skills or agents (one from a Settings row, or a whole un-bridged set).
   * Empty = closed. */
  items: { name: string; sourcePath: string }[];
  /** The resource word for the user-visible copy ('skill' | 'agent'). */
  noun?: string;
  /** The source's scope, used to default-select the target. */
  sourceScope?: 'global' | 'project';
  sourceProjectId?: string;
  /** The tool in play (the chat's provider, or the row's CLI) — enables the "this tool only" breadth. */
  activeTool?: Tool;
  projects: Project[];
  onClose: () => void;
  onSubmit: (target: 'global' | 'project', projectId: string | undefined, mode: CopyMode) => void;
};

/**
 * "Copy across" picker — mirrors ChangeScopeDialog but COPIES (file-copy) instead of moving DB scope.
 * Target = Global (machine-local `~`) or a project (its own tool dirs). Breadth = Portable (each tool's
 * native dir → readable everywhere) or just the active tool's dir. A project target may add committable
 * repo files — surfaced as a note, never a gate (provider-config-canonical-home).
 */
export const CopyAcrossDialog = memo(function CopyAcrossDialog({
  items,
  noun = 'skill',
  sourceScope,
  sourceProjectId,
  activeTool,
  projects,
  onClose,
  onSubmit,
}: Props): ReactElement | null {
  const [value, setValue] = useState('global'); // 'global' | `project-<id>`
  const [mode, setMode] = useState<CopyMode>('portable');

  useEffect(() => {
    if (items.length > 0) {
      setValue(
        sourceScope === 'project' && sourceProjectId ? `project-${sourceProjectId}` : 'global',
      );
      setMode('portable');
    }
  }, [items.length, sourceScope, sourceProjectId]);

  if (items.length === 0) return null;

  const projectId = value.startsWith('project-') ? value.slice('project-'.length) : undefined;
  const targetProject = projects.find((p) => p.id === projectId);
  const label = items.length === 1 ? items[0].name : `${items.length} ${noun}s`;

  return (
    <Dialog open={items.length > 0} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy across: {label}</DialogTitle>
          <DialogDescription>
            Copy {label} into another tool scope so the tools there can read it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-4">
          <label htmlFor="copy-across-target" className="text-sm font-medium mb-1 block">
            Copy to
          </label>
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger id="copy-across-target">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">
                <div className="flex items-center gap-2">
                  <Globe className="h-3.5 w-3.5" />
                  Global (machine-local, follows you everywhere)
                </div>
              </SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={`project-${p.id}`}>
                  <div className="flex items-center gap-2">
                    <Laptop className="h-3.5 w-3.5" />
                    {p.name}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {targetProject && (
            <p className="text-xs text-muted-foreground">
              Adds files to <span className="font-medium">{targetProject.name}</span> — if that
              project's <code>.claude</code> isn't gitignored, they become part of its repo.
            </p>
          )}

          {activeTool && (
            <>
              <label htmlFor="copy-across-breadth" className="text-sm font-medium mb-1 block">
                Add a copy to
              </label>
              <Select value={mode} onValueChange={(v) => setMode(v as CopyMode)}>
                <SelectTrigger id="copy-across-breadth">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="portable">All your tools (portable)</SelectItem>
                  <SelectItem value="native">{TOOL_LABEL[activeTool]} only</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Copies the {noun} — the original stays where it is.
              </p>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(projectId ? 'project' : 'global', projectId, mode)}>
            Copy
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
});
