/**
 * Create flow dialog (name, description, optional project).
 */

import { Button, Input } from '@benord-labs/frink-primitives';
import { type ReactElement, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Label } from '../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import { trpc } from '../../../lib/trpc';

/** Radix Select needs a string value; this maps to `projectId === null`. */
const NO_CLOUD_PROJECT_VALUE = '__flow_no_project__';

type CreateFlowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (flowId: string) => void;
};

export function CreateFlowDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateFlowDialogProps): ReactElement {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: projects } = trpc.projects.list.useQuery(undefined, { enabled: open });
  const createMutation = trpc.flows.create.useMutation({
    onSuccess: (row) => {
      setName('');
      setDescription('');
      setProjectId(null);
      setFormError(null);
      onOpenChange(false);
      onCreated(row.id);
    },
    onError: (err) => {
      setFormError(err.message || 'Could not create flow');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('Name is required');
      return;
    }
    createMutation.mutate({
      name: trimmed,
      description: description.trim() || null,
      projectId,
    });
  };

  const localProjects = Array.isArray(projects) ? projects : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New flow</DialogTitle>
            <DialogDescription>
              Flows run a linear sequence of steps. You can add steps after creating.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="flow-name">Name</Label>
              <Input
                id="flow-name"
                value={name}
                onChange={(ev) => setName(ev.target.value)}
                placeholder="e.g. Review incoming PRs"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="flow-desc">Description (optional)</Label>
              <Input
                id="flow-desc"
                value={description}
                onChange={(ev) => setDescription(ev.target.value)}
                placeholder="What this flow does"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="flow-project">Project (optional)</Label>
              <Select
                value={projectId ?? NO_CLOUD_PROJECT_VALUE}
                onValueChange={(v) => setProjectId(v === NO_CLOUD_PROJECT_VALUE ? null : v)}
              >
                <SelectTrigger
                  id="flow-project"
                  aria-describedby="flow-project-hint"
                  className="w-full"
                >
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CLOUD_PROJECT_VALUE}>None</SelectItem>
                  {localProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name ?? p.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p id="flow-project-hint" className="text-[11px] text-muted-foreground">
                Steps in this flow run in this project by default; change it later in flow settings.
              </p>
            </div>
            {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
