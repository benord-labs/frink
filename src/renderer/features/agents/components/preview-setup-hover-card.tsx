import githubLogo from '@iconify-icons/simple-icons/github';
import { iconifyComponent } from '@/lib/utils/iconify-component';
// import Image from "next/image" // Desktop doesn't use next/image
import { Button } from '@benord-labs/frink-primitives';
import { atom, useSetAtom } from 'jotai';
import { useTheme } from 'next-themes';
import { useState } from 'react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../components/ui/hover-card';

const GitHubIcon = iconifyComponent(githubLogo);

// import { agentsSettingsDialogOpenAtom, agentsSettingsDialogActiveTabAtom } from "@/lib/atoms/agents-settings-dialog"
const agentsSettingsDialogOpenAtom = atom(false);
const agentsSettingsDialogActiveTabAtom = atom<string | null>(null);

type PreviewSetupHoverCardProps = {
  children: React.ReactNode;
};

export function PreviewSetupHoverCard({ children }: PreviewSetupHoverCardProps) {
  const { resolvedTheme } = useTheme();
  const setSettingsDialogOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);
  const [open, setOpen] = useState(false);

  const handleOpenSettings = () => {
    setSettingsActiveTab('github');
    setSettingsDialogOpen(true);
    setOpen(false);
  };

  return (
    <HoverCard openDelay={300} open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        className="w-[280px] p-0 overflow-hidden"
        align="end"
        side="bottom"
        sideOffset={8}
      >
        {/* Image Section - styled like onboarding dialog */}
        <div className="bg-primary px-4 pt-8 flex items-start justify-center">
          <div className="relative w-full flex items-start justify-center pt-3">
            {/* Container showing only top 70% of image (16/7 aspect ratio = 70% of 16/10) */}
            <div
              className="relative w-full overflow-hidden rounded-t-lg border"
              style={{ aspectRatio: '16/7', maxHeight: '110px' }}
            >
              <div className="absolute inset-0" style={{ height: '142.86%', top: 0 }}>
                {/* Desktop: use regular img tag instead of next/image */}
                <img
                  src={
                    resolvedTheme === 'dark'
                      ? '/agents-onboarding-dark.webp'
                      : '/agents-onboarding-light.webp'
                  }
                  alt="Preview setup"
                  className="object-cover w-full h-full"
                  style={{ objectPosition: 'top' }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3">
          <div className="space-y-1.5">
            <h4 className="text-sm font-semibold">Preview not available</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              To see live preview of your changes, you need to set up your repository first.
            </p>
          </div>

          {/* Action button */}
          <Button
            onClick={handleOpenSettings}
            className="w-full gap-2 px-3 py-2 text-sm bg-foreground text-background hover:bg-foreground/90 rounded-md"
          >
            <GitHubIcon className="h-3.5 w-3.5" />
            <span>Set up repository</span>
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
