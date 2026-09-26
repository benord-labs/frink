import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type TerminalCwdSwitchDialogProps = {
  open: boolean;
  nextCwd: string;
  onOpenChange: (open: boolean) => void;
  onMoveDirectory: () => void;
  onKeepCurrent: () => void;
  onDetachTerminal: () => void;
};

export function TerminalCwdSwitchDialog({
  open,
  nextCwd,
  onOpenChange,
  onMoveDirectory,
  onKeepCurrent,
  onDetachTerminal,
}: TerminalCwdSwitchDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="w-[560px] max-w-[calc(100%-1rem)]">
        <AlertDialogHeader>
          <AlertDialogTitle>Switch terminal directory?</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody>
          <AlertDialogDescription>
            This terminal is already active. Move it to:
            <br />
            <span className="text-foreground font-mono text-xs break-all">{nextCwd}</span>
          </AlertDialogDescription>
        </AlertDialogBody>
        <AlertDialogFooter className="flex-wrap justify-end">
          <AlertDialogCancel className="max-sm:w-full" onClick={onKeepCurrent}>
            Keep current directory
          </AlertDialogCancel>
          <AlertDialogAction
            className="max-sm:w-full bg-secondary text-secondary-foreground hover:bg-secondary/90"
            onClick={onDetachTerminal}
          >
            Detach terminal
          </AlertDialogAction>
          <AlertDialogAction className="max-sm:w-full" onClick={onMoveDirectory}>
            Move directory
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
