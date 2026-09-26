/* eslint-disable max-lines, max-lines-per-function */
import { Button, Input, Textarea } from '@benord-labs/frink-primitives';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { SlashCommandOption } from '@/lib/commands/types';
import { VALID_COMMAND_NAME } from '../../../../shared/lib/command-name';
import {
  CanvasDialogBody,
  CanvasDialogContent,
  CanvasDialogFooter,
  CanvasDialogHeader,
  Dialog,
  DialogDescription,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { Label } from '../../../components/ui/label';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';

type CommandEditorModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the modal edits an existing command instead of creating */
  editingCommand?: SlashCommandOption | null;
  /** Pre-filled name when creating from search text */
  prefillName?: string;
  /** Pre-filled content when forking a non-frink command */
  prefillContent?: string;
  /** Current project path (enables project-scoped option) */
  projectPath?: string;
  /** Called after a successful create/update/delete so the parent can invalidate queries */
  onSuccess?: () => void;
};

export function CommandEditorModal({
  open,
  onOpenChange,
  editingCommand,
  prefillName = '',
  prefillContent = '',
  projectPath,
  onSuccess,
}: CommandEditorModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);

  const isEditing = !!editingCommand;

  const trpcUtils = trpc.useUtils();

  // Load full command data when editing
  const { data: fullCommand } = trpc.commands.getFull.useQuery(
    { path: editingCommand?.path ?? '' },
    { enabled: isEditing && !!editingCommand?.path && open },
  );

  // Populate form when editing
  useEffect(() => {
    if (isEditing && editingCommand) {
      setName(editingCommand.name);
      setDescription(fullCommand?.description ?? editingCommand.description ?? '');
      setContent(fullCommand?.content ?? '');
      setScope(editingCommand.source ?? 'user');
    }
  }, [isEditing, editingCommand, fullCommand]);

  // Reset form when opening for create
  useEffect(() => {
    if (open && !isEditing) {
      setName(prefillName);
      setDescription('');
      setContent(prefillContent);
      setScope(projectPath ? 'project' : 'user');
    }
    // Always reset confirmation and error state when opening/closing
    setConfirmingDelete(false);
    setNameError(null);
    setContentError(null);
  }, [open, isEditing, projectPath, prefillName, prefillContent]);

  const listInput = useMemo(() => ({ projectPath }), [projectPath]);

  /** Shared optimistic mutation lifecycle: cancel → snapshot → transform → rollback/invalidate */
  type ListData = ReturnType<typeof trpcUtils.commands.list.getData>;
  function optimisticOpts<TVariables>(
    transform: (old: NonNullable<ListData>, variables: TVariables) => NonNullable<ListData>,
    successMessage: string,
  ) {
    return {
      onMutate: async (variables: TVariables) => {
        await trpcUtils.commands.list.cancel(listInput);
        const previous = trpcUtils.commands.list.getData(listInput);
        trpcUtils.commands.list.setData(listInput, (old) =>
          old ? transform(old, variables) : old,
        );
        return { previous };
      },
      onSuccess: () => {
        toast.success(successMessage);
        onSuccess?.();
        onOpenChange(false);
      },
      onError: (err: { message: string }, _vars: TVariables, context?: { previous?: ListData }) => {
        if (context?.previous) trpcUtils.commands.list.setData(listInput, context.previous);
        toast.error(err.message);
      },
      onSettled: () => {
        trpcUtils.commands.list.invalidate(listInput);
      },
    };
  }

  const createMutation = trpc.commands.create.useMutation(
    optimisticOpts(
      (old, variables) => [
        ...old,
        {
          name: variables.name,
          description: variables.description ?? '',
          takesArguments: variables.content.includes('$ARGUMENTS'),
          source: variables.scope,
          origin: 'frink' as const,
          path: '',
        },
      ],
      `Command /${name} created`,
    ),
  );

  const updateMutation = trpc.commands.update.useMutation(
    optimisticOpts(
      (old, variables) =>
        old.map((cmd) =>
          cmd.path === variables.path
            ? {
                ...cmd,
                name: variables.newName ?? cmd.name,
                description: variables.description ?? cmd.description,
                takesArguments: variables.content.includes('$ARGUMENTS'),
              }
            : cmd,
        ),
      `Command /${name.trim() || editingCommand?.name} updated`,
    ),
  );

  const deleteMutation = trpc.commands.delete.useMutation(
    optimisticOpts(
      (old, variables) => old.filter((cmd) => cmd.path !== variables.path),
      `Command /${editingCommand?.name} deleted`,
    ),
  );

  const isPending =
    createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  const handleSubmit = useCallback(() => {
    const trimmedName = name.trim();
    let hasError = false;

    if (!trimmedName) {
      setNameError('Command name is required');
      hasError = true;
    } else if (!VALID_COMMAND_NAME.test(trimmedName)) {
      setNameError(
        'Name can only contain letters, numbers, hyphens, underscores, and colons (for namespaces)',
      );
      hasError = true;
    } else {
      setNameError(null);
    }

    if (!content.trim()) {
      setContentError('Prompt content is required');
      hasError = true;
    } else {
      setContentError(null);
    }

    if (hasError) return;

    if (isEditing && editingCommand?.path) {
      const nameChanged = trimmedName !== editingCommand.name;
      updateMutation.mutate({
        path: editingCommand.path,
        ...(nameChanged ? { newName: trimmedName } : {}),
        description: description.trim() || undefined,
        content: content.trim(),
      });
    } else {
      createMutation.mutate({
        name: trimmedName,
        description: description.trim() || undefined,
        content: content.trim(),
        scope,
        projectPath,
      });
    }
  }, [
    name,
    description,
    content,
    scope,
    projectPath,
    isEditing,
    editingCommand,
    createMutation,
    updateMutation,
  ]);

  const handleDelete = useCallback(() => {
    if (!editingCommand?.path) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    deleteMutation.mutate({ path: editingCommand.path });
  }, [editingCommand, deleteMutation, confirmingDelete]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <CanvasDialogContent className="sm:max-w-[480px]">
        <CanvasDialogHeader>
          <DialogTitle>{isEditing ? 'Edit Command' : 'Create Command'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Modify your slash command prompt.'
              : 'Create a reusable prompt you can invoke with /name.'}
          </DialogDescription>
        </CanvasDialogHeader>

        <CanvasDialogBody className="space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="cmd-name" className="text-sm">
              Name
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">
                /
              </span>
              <Input
                id="cmd-name"
                placeholder="my-command or git:commit"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (nameError) setNameError(null);
                }}
                disabled={isPending || (isEditing && editingCommand?.origin !== 'frink')}
                error={!!nameError}
                className="h-9 pl-6"
                aria-invalid={!!nameError}
                aria-describedby={nameError ? 'cmd-name-error' : undefined}
              />
            </div>
            {nameError && (
              <p id="cmd-name-error" className="text-xs text-destructive" role="alert">
                {nameError}
              </p>
            )}
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="cmd-desc" className="text-sm">
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id="cmd-desc"
              placeholder="A short description shown in the dropdown"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isPending}
              className="h-9"
            />
          </div>

          {/* Scope indicator (read-only) when editing */}
          {isEditing && editingCommand?.source && (
            <div className="space-y-1.5">
              <Label className="text-sm">Scope</Label>
              <p className="text-xs text-muted-foreground">
                {editingCommand.source === 'project' ? 'Project' : 'User (global)'} command
              </p>
            </div>
          )}

          {/* Scope selector (only for create) */}
          {!isEditing && (
            <div className="space-y-1.5">
              <Label className="text-sm">Scope</Label>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setScope('user')}
                  disabled={isPending}
                  className={cn(
                    'flex-1 flex-col items-start rounded-lg border px-3 py-2 h-auto text-xs font-normal',
                    scope === 'user'
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:border-primary/50',
                  )}
                >
                  <span className="font-medium">User</span>
                  <span className="block text-[10px] mt-0.5 text-muted-foreground">
                    ~/.frink/commands/
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setScope('project')}
                  disabled={isPending || !projectPath}
                  className={cn(
                    'flex-1 flex-col items-start rounded-lg border px-3 py-2 h-auto text-xs font-normal',
                    scope === 'project'
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:border-primary/50',
                    !projectPath && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <span className="font-medium">Project</span>
                  <span className="block text-[10px] mt-0.5 text-muted-foreground">
                    {projectPath
                      ? `.frink/commands/ in ${projectPath.split('/').pop()}`
                      : 'Select a project first'}
                  </span>
                </Button>
              </div>
            </div>
          )}

          {/* Prompt content */}
          <div className="space-y-1.5">
            <Label htmlFor="cmd-content" className="text-sm">
              Prompt
            </Label>
            <Textarea
              id="cmd-content"
              placeholder="The prompt that will be sent to the agent when this command is invoked..."
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                if (contentError) setContentError(null);
              }}
              disabled={isPending}
              rows={6}
              error={!!contentError}
              className="resize-y text-sm font-mono"
              aria-invalid={!!contentError}
              aria-describedby={contentError ? 'cmd-content-error' : undefined}
            />
            {contentError && (
              <p id="cmd-content-error" className="text-xs text-destructive" role="alert">
                {contentError}
              </p>
            )}
          </div>
        </CanvasDialogBody>

        <CanvasDialogFooter>
          {/* Delete button with two-step confirmation (only for editing frink commands) */}
          {isEditing && editingCommand?.origin === 'frink' && (
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              onBlur={() => setConfirmingDelete(false)}
              disabled={isPending}
              className="mr-auto transition-transform duration-150 active:scale-[0.97] rounded-md"
            >
              {deleteMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : confirmingDelete ? (
                'Confirm Delete'
              ) : (
                'Delete'
              )}
            </Button>
          )}

          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
            className="transition-transform duration-150 active:scale-[0.97] rounded-md"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isPending}
            className="transition-transform duration-150 active:scale-[0.97] rounded-md"
          >
            {createMutation.isPending || updateMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {isEditing ? 'Saving...' : 'Creating...'}
              </>
            ) : isEditing ? (
              'Save'
            ) : (
              'Create Command'
            )}
          </Button>
        </CanvasDialogFooter>
      </CanvasDialogContent>
    </Dialog>
  );
}
