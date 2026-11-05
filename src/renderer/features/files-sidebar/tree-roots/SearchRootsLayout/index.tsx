import type { ComponentProps, ReactElement } from 'react';
import type { TreeProjects } from '@/lib/workspace-context/use-tree-projects';
import { ContentSearchResults } from '../../ContentSearchResults';
import { SEARCH_SECTION_CLASS, THIS_CHAT_BADGE } from '../constants';
import { ExtraProjectContentSearch } from '../ExtraProjectContentSearch';
import { RootHeading } from '../ProjectRootRow';

type Props = Omit<
  ComponentProps<typeof ContentSearchResults>,
  'heading' | 'className' | 'emptyMessage'
> & {
  /** The chat's tree projects, from useTreeProjects */
  projects: Pick<TreeProjects, 'main' | 'extras'>;
  /** The chat whose tree this is */
  chatId: string;
  /** The folder the chat's own results come from */
  mainPath: string;
  /** The split-view pane the tree sits in */
  paneIndex?: number;
};

/**
 * The Search tab's results for a chat's tree, given the chat's own results. With other projects in
 * the tree and a valid query typed, one scroll area holds the chat's matches under This chat, then
 * each other project's under its name, in tree order; each project counts and pages its own
 * matches. Otherwise the chat's results show as they always have: a blank or invalid query reads
 * the same in every project, so its message shows once.
 */
export function SearchRootsLayout({
  projects: { main, extras },
  chatId,
  mainPath,
  paneIndex,
  ...results
}: Props): ReactElement {
  if (!main || extras.length === 0 || results.query.trim() === '' || results.invalidRegex) {
    return <ContentSearchResults {...results} />;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1 scrollbar-thin">
      <ContentSearchResults
        {...results}
        heading={<RootHeading name={main.name} path={mainPath} badge={THIS_CHAT_BADGE} />}
        className={SEARCH_SECTION_CLASS}
        emptyMessage={`No matches in ${main.name}.`}
      />
      {extras.map((project) => (
        <ExtraProjectContentSearch
          key={project.id}
          project={project}
          chatId={chatId}
          paneIndex={paneIndex}
          query={results.query}
        />
      ))}
    </div>
  );
}
