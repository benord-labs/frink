import { Button, Input } from '@benord-labs/frink-primitives';
import { Check, ChevronDown, GitBranch, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../../components/ui/command';
import {
  CanvasDialogBody,
  CanvasDialogContent,
  CanvasDialogFooter,
  CanvasDialogHeader,
  Dialog,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Label } from '../../../components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { formatTimeAgo } from '../utils/format-time-ago';

// Regex pattern for branch name validation (alphanumeric, dots, hyphens, underscores, slashes)
const BRANCH_NAME_REGEX = /^[a-zA-Z0-9._/-]+$/;

type CreateBranchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  branches: Array<{
    name: string;
    isDefault: boolean;
    committedAt: string | null;
    protected?: boolean;
  }>;
  defaultBranch: string;
  onBranchCreated: (branchName: string) => void;
};

export function CreateBranchDialog({
  open,
  onOpenChange,
  projectPath,
  branches,
  defaultBranch,
  onBranchCreated,
}: CreateBranchDialogProps) {
  const [branchName, setBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState(defaultBranch);
  const [baseBranchOpen, setBaseBranchOpen] = useState(false);
  const [baseBranchSearch, setBaseBranchSearch] = useState('');

  // Reset baseBranch when defaultBranch changes
  useEffect(() => {
    setBaseBranch(defaultBranch);
  }, [defaultBranch]);

  // Reset search when popover closes
  useEffect(() => {
    if (!baseBranchOpen) {
      setBaseBranchSearch('');
    }
  }, [baseBranchOpen]);

  // Filter branches based on search (limit to 50 for performance)
  const filteredBaseBranches = useMemo(() => {
    let filtered = branches;
    if (baseBranchSearch.trim()) {
      const search = baseBranchSearch.toLowerCase();
      filtered = branches.filter((b) => b.name.toLowerCase().includes(search));
    }
    return filtered.slice(0, 50);
  }, [branches, baseBranchSearch]);

  const utils = trpc.useUtils();

  const createBranchMutation = trpc.changes.createBranch.useMutation({
    onSuccess: (data) => {
      toast.success(`Branch '${data.branchName}' created successfully`);
      // Invalidate branches query to refresh the list
      utils.changes.getBranches.invalidate({ worktreePath: projectPath });
      onBranchCreated(data.branchName);
      onOpenChange(false);
      setBranchName('');
      setBaseBranch(defaultBranch);
    },
    onError: (error) => {
      toast.error(`Failed to create branch: ${error.message}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!branchName.trim()) {
      toast.error('Branch name is required');
      return;
    }

    // Basic validation for branch name
    if (!BRANCH_NAME_REGEX.test(branchName)) {
      toast.error(
        'Branch name can only contain letters, numbers, dots, hyphens, underscores, and slashes',
      );
      return;
    }

    createBranchMutation.mutate({
      projectPath,
      branchName: branchName.trim(),
      baseBranch,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <CanvasDialogContent className="sm:max-w-[350px]">
        <CanvasDialogHeader>
          <DialogTitle>Create a Branch</DialogTitle>
        </CanvasDialogHeader>

        <CanvasDialogBody className="space-y-4">
          {/* Branch Name Input */}
          <div className="space-y-2">
            <Label htmlFor="branch-name" className="text-sm">
              Name
            </Label>
            <Input
              id="branch-name"
              placeholder="feature/my-new-feature"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && branchName.trim() && !createBranchMutation.isPending) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              autoFocus
              disabled={createBranchMutation.isPending}
              size="md"
            />
          </div>

          {/* Base Branch Selection with Search */}
          <div className="space-y-2">
            <Label className="text-sm">Create branch based on...</Label>
            <Popover open={baseBranchOpen} onOpenChange={setBaseBranchOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="secondary"
                  className={cn(
                    'flex h-9 w-full justify-between gap-2 rounded-[10px] px-3 py-2 text-sm',
                  )}
                  disabled={createBranchMutation.isPending}
                >
                  <span className="truncate">{baseBranch}</span>
                  <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              {/* Portalled out of the frosted dialog: inside it, the dialog is all its blur can reach. */}
              <PopoverContent
                className="p-0"
                align="start"
                style={{ width: 'var(--radix-popover-trigger-width)' }}
              >
                <Command>
                  <CommandInput
                    placeholder="Search branches..."
                    value={baseBranchSearch}
                    onValueChange={setBaseBranchSearch}
                  />
                  <CommandList className="max-h-[200px]">
                    {filteredBaseBranches.length === 0 ? (
                      <CommandEmpty>No branches found.</CommandEmpty>
                    ) : (
                      <CommandGroup>
                        {filteredBaseBranches.map((branch) => (
                          <CommandItem
                            key={branch.name}
                            value={branch.name}
                            onSelect={() => {
                              setBaseBranch(branch.name);
                              setBaseBranchOpen(false);
                            }}
                            className="gap-2 cursor-pointer"
                          >
                            <GitBranch className="h-4 w-4 text-muted-foreground shrink-0" />
                            <span className="truncate flex-1">{branch.name}</span>
                            {branch.committedAt && (
                              <span className="text-xs text-muted-foreground/70 shrink-0">
                                {formatTimeAgo(branch.committedAt)}
                              </span>
                            )}
                            {baseBranch === branch.name && <Check className="h-4 w-4 shrink-0" />}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
        </CanvasDialogBody>

        <CanvasDialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={createBranchMutation.isPending}
            className="transition-transform duration-150 active:scale-[0.97] rounded-md"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={(e) => handleSubmit(e)}
            disabled={!branchName.trim() || createBranchMutation.isPending}
            className="transition-transform duration-150 active:scale-[0.97] rounded-md"
          >
            {createBranchMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              'Create Branch'
            )}
          </Button>
        </CanvasDialogFooter>
      </CanvasDialogContent>
    </Dialog>
  );
}
