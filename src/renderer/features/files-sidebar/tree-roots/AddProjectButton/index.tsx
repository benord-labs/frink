import { Button } from '@benord-labs/frink-primitives';
import { FolderPlus } from 'lucide-react';
import type { ReactElement } from 'react';
import { LinkProjectPicker } from '@/components/ProjectPicker/LinkProjectPicker';

type Props = {
  chatId: string | undefined;
  /** The chat's loaded message texts; the projects they name by folder are listed first */
  getMentionTexts?: () => string[];
};

/**
 * Opens a picker of the user's other projects; the one picked is linked to the chat and shows below
 * the chat's own project in its file tree. Nothing shows for a chat without a project folder of its
 * own.
 */
export function AddProjectButton({ chatId, getMentionTexts }: Props): ReactElement | null {
  return (
    <LinkProjectPicker
      chatId={chatId}
      getMentionTexts={getMentionTexts}
      trigger={
        // Icon only, unless the header (container `files-header`) has room for the label
        <Button
          variant="ghost"
          size="sm"
          aria-label="Link project"
          className="size-8 shrink-0 px-0 text-muted-foreground hover:bg-foreground/5 hover:text-foreground @min-[22rem]/files-header:w-auto @min-[22rem]/files-header:px-2"
        >
          <FolderPlus className="h-4 w-4 shrink-0" aria-hidden />
          <span className="hidden @min-[22rem]/files-header:inline">Link project</span>
        </Button>
      }
    />
  );
}
