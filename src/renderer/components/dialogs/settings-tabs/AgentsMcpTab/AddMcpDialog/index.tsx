import { Button, Input } from '@benord-labs/frink-primitives';
import { Loader2, Trash2 } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (data: {
    name: string;
    command: string;
    args: string;
    envVars: Record<string, string>;
  }) => Promise<void>;
};

export const AddMcpDialog = memo(function AddMcpDialog({ open, onOpenChange, onAdd }: Props) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [envVarKey, setEnvVarKey] = useState('');
  const [envVarValue, setEnvVarValue] = useState('');
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleAddEnvVar = useCallback(() => {
    if (envVarKey && envVarValue) {
      setEnvVars((prev) => ({ ...prev, [envVarKey]: envVarValue }));
      setEnvVarKey('');
      setEnvVarValue('');
    }
  }, [envVarKey, envVarValue]);

  const handleRemoveEnvVar = useCallback((key: string) => {
    setEnvVars((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!name || !command) {
      toast.error('Name and command are required');
      return;
    }

    setIsSubmitting(true);
    try {
      await onAdd({ name, command, args, envVars });
      // Reset form
      setName('');
      setCommand('');
      setArgs('');
      setEnvVars({});
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add MCP');
    } finally {
      setIsSubmitting(false);
    }
  }, [name, command, args, envVars, onAdd, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add MCP Server</DialogTitle>
          <DialogDescription>
            Configure a new MCP server. It will be available to all AI providers.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              placeholder="e.g., github, postgres, figma"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Command */}
          <div className="space-y-2">
            <Label htmlFor="mcp-command">Command</Label>
            <Input
              id="mcp-command"
              placeholder="e.g., npx, node, python"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </div>

          {/* Args */}
          <div className="space-y-2">
            <Label htmlFor="mcp-args">Arguments (space-separated)</Label>
            <Input
              id="mcp-args"
              placeholder="e.g., -y @modelcontextprotocol/server-github"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
          </div>

          {/* Environment Variables */}
          <div className="space-y-2">
            <Label>Environment Variables (API Keys, etc.)</Label>
            <div className="flex gap-2">
              <Input
                placeholder="Key (e.g., GITHUB_TOKEN)"
                value={envVarKey}
                onChange={(e) => setEnvVarKey(e.target.value)}
                className="flex-1"
              />
              <Input
                placeholder="Value"
                type="password"
                value={envVarValue}
                onChange={(e) => setEnvVarValue(e.target.value)}
                className="flex-1"
              />
              <Button type="button" variant="secondary" size="sm" onClick={handleAddEnvVar}>
                Add
              </Button>
            </div>
            {Object.keys(envVars).length > 0 && (
              <div className="space-y-1 mt-2">
                {Object.entries(envVars).map(([key]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between px-2 py-1 bg-muted rounded text-xs"
                  >
                    <span className="font-mono">{key}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0"
                      onClick={() => handleRemoveEnvVar(key)}
                      iconOnly
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Credentials are stored locally and encrypted. Never synced to cloud.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !name || !command}>
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add Server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
