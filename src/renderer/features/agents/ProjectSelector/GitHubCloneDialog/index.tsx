import { Button, Input } from '@benord-labs/frink-primitives';
import { Dialog, DialogContent, DialogTitle } from '../../../../components/ui/dialog';

type GitHubCloneDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  onUrlChange: (url: string) => void;
  /** Triggered on form submit; the parent owns the clone mutation + url validation. */
  onSubmit: () => void;
  isPending: boolean;
};

export function GitHubCloneDialog({
  open,
  onOpenChange,
  url,
  onUrlChange,
  onSubmit,
  isPending,
}: GitHubCloneDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[400px] p-0 gap-0 overflow-hidden">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <div className="p-6">
            <DialogTitle className="text-xl mb-4">Clone from GitHub</DialogTitle>
            <Input
              placeholder="owner/repo or https://github.com/..."
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              size="lg"
              autoFocus
            />
          </div>
          <div className="bg-muted p-4 flex justify-between border-t border-border">
            <Button
              type="button"
              onClick={() => onOpenChange(false)}
              variant="ghost"
              className="rounded-md"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!url.trim() || isPending}
              variant="primary"
              className="rounded-md"
            >
              {isPending ? 'Cloning...' : 'Clone'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
