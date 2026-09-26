import { type ReactElement, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CopyAcrossDialog } from '@/components/ui/copy-across-dialog';
import { showCopyResultToast } from '@/lib/copy-across-toast';
import {
  dismissForever,
  isDismissed,
  snooze,
  snoozeOrEscalate,
} from '@/lib/stores/unbridged-dismissals';
import { trpc } from '@/lib/trpc';

type Pending = {
  projectId: string;
  providerKind: 'claude-code' | 'cursor';
  skills: { name: string; sourcePath: string }[];
};

const TOOL_LABEL: Record<'claude-code' | 'cursor', string> = {
  'claude-code': 'Claude',
  cursor: 'Cursor',
};

/**
 * ONE app-level listener for the spawn-time `provider:unbridged` signal — when a chat opens in a project
 * that has skills the spawning tool can't read, toast "make them follow you?" → open the Copy-across dialog
 * seeded with that project + set. Mount ONCE (not per-chat). The copy itself is the user's explicit click.
 */

/** Name the skills (first few), e.g. "frontend-design" or "a, b +2 more". */
function summariseSkills(skills: { name: string }[]): string {
  const names = skills.map((s) => s.name);
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} +${names.length - 3} more` : shown;
}

export function showUnbridgedToast(data: Pending, onCopy: () => void): void {
  const n = data.skills.length;
  const tool = TOOL_LABEL[data.providerKind];
  const names = data.skills.map((s) => s.name);
  // sonner only fires onDismiss (close button / swipe) and onAutoClose (timeout) — never on an
  // action/cancel click — so an explicit Copy-across / Don't-ask-again can't also self-snooze.
  // An ignored toast (auto-close) just snoozes; only an active dismiss escalates toward permanent.
  toast(`${summariseSkills(data.skills)} ${n === 1 ? "isn't" : "aren't"} in ${tool} yet`, {
    description: 'Make them follow you across your tools?',
    action: { label: 'Copy across', onClick: onCopy },
    cancel: {
      label: "Don't ask again",
      onClick: () => dismissForever(data.projectId, data.providerKind, names),
    },
    onDismiss: () => snoozeOrEscalate(data.projectId, data.providerKind, names),
    onAutoClose: () => snooze(data.projectId, data.providerKind, names),
  });
}

export function CopyAcrossPrompt(): ReactElement {
  const [pending, setPending] = useState<Pending | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: rawProjects } = trpc.projects.list.useQuery();
  const projects = Array.isArray(rawProjects) ? rawProjects : [];

  const copyAcrossMutation = trpc.skills.copyAcross.useMutation({
    onSuccess: (res) => showCopyResultToast(res, 'skill'),
    onError: (e) => toast.error(e.message || 'Failed to copy'),
  });

  useEffect(() => {
    return window.desktopApi?.onProviderUnbridged?.((data) => {
      // Drop skills the user has snoozed or permanently declined — only nag about live ones.
      const skills = data.skills.filter(
        (s) => !isDismissed(data.projectId, data.providerKind, s.name),
      );
      if (skills.length === 0) return;
      const live = { ...data, skills };
      setPending(live);
      showUnbridgedToast(live, () => setDialogOpen(true));
    });
  }, []);

  return (
    <CopyAcrossDialog
      items={dialogOpen && pending ? pending.skills : []}
      noun="skill"
      sourceScope="project"
      sourceProjectId={pending?.projectId}
      activeTool={pending?.providerKind}
      projects={projects}
      onClose={() => setDialogOpen(false)}
      onSubmit={(target, projectId, mode) => {
        if (pending) {
          copyAcrossMutation.mutate({
            skills: pending.skills,
            target,
            projectId,
            mode,
            activeTool: pending.providerKind,
          });
        }
        setDialogOpen(false);
      }}
    />
  );
}
