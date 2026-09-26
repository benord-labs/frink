import { type ReactElement, useCallback } from 'react';
import { toast } from 'sonner';
import { ToolCase } from 'lucide-react';
import { showCopyResultToast } from '@/lib/copy-across-toast';
import { trpc } from '@/lib/trpc';
import { type CopyMutationInput, ResourceSettingsTab } from '../ResourceSettingsTab';

// Reason: thin wrappers bound to separately typed tRPC routers; a shared generic adds code.
// fallow-ignore-next-line code-duplication
const SKILLS_CONFIG = {
  noun: 'skills',
  emptyIcon: ToolCase,
  emptyTitle: 'No skills yet',
  emptyBody: 'Add one to your skills folder and it shows up here.',
  usage: (name: string) => (
    <>
      Mention it with <code className="font-mono text-[12px]">@{name}</code> in chat.
    </>
  ),
  // Frink provisions its built-in skills into this folder at boot, so it always exists.
  folder: '.claude/skills',
} as const;

export function AgentsSkillsTab(): ReactElement {
  const {
    data: rawSkills,
    isLoading,
    refetch,
  } = trpc.skills.getAggregatedSkillInfo.useQuery(undefined);
  const skills = Array.isArray(rawSkills) ? rawSkills : [];

  const copyAcrossMutation = trpc.skills.copyAcross.useMutation({
    onSuccess: (res) => {
      showCopyResultToast(res, 'skill');
      refetch();
    },
    onError: (error) => toast.error(error.message || 'Failed to copy'),
  });

  const handleCopyAcross = useCallback(
    ({ items, ...rest }: CopyMutationInput) =>
      copyAcrossMutation.mutate({ skills: items, ...rest }),
    [copyAcrossMutation],
  );

  return (
    <ResourceSettingsTab
      config={SKILLS_CONFIG}
      items={skills}
      isLoading={isLoading}
      copyAcross={{ noun: 'skill', onCopy: handleCopyAcross }}
    />
  );
}
