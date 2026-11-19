import type { ComponentProps, ReactElement } from 'react';
import type { TreeProjects } from '@/lib/workspace-context/use-tree-projects';
import { ContentSearchResults } from '../../ContentSearchResults';
import { MAIN_BADGE, SEARCH_SECTION_CLASS } from '../constants';
import { LinkedProjectContentSearch } from '../LinkedProjectContentSearch';
import { RootHeading } from '../ProjectRootRow';

type Props = Omit<
  ComponentProps<typeof ContentSearchResults>,
  'heading' | 'className' | 'emptyMessage'
> & {
  /** The chat's tree projects, from useTreeProjects */
  projects: Pick<TreeProjects, 'main' | 'linked'>;
  /** The chat whose tree this is */
  chatId: string;
  /** The folder the chat's own results come from */
  mainPath: string;
  /** The split-view pane the tree sits in */
  paneIndex?: number;
};

/**
 * The Search tab's results for a chat's tree, given the chat's own results. With linked projects in
 * the tree and a valid query typed, one scroll area holds the chat's matches under Main, then
 * each linked project's under its name, in tree order; each project counts and pages its own
 * matches. Otherwise the chat's results show as they always have: a blank or invalid query reads
 * the same in every project, so its message shows once. While the typed query is still to be
 * searched (`isStale`), every section marks what it shows as out of date.
 */
export function SearchRootsLayout({
  projects: { main, linked },
  chatId,
  mainPath,
  paneIndex,
  ...results
}: Props): ReactElement {
  if (!main || linked.length === 0 || results.query.trim() === '' || results.invalidRegex) {
    return <ContentSearchResults {...results} />;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1 scrollbar-thin">
      <ContentSearchResults
        {...results}
        heading={<RootHeading name={main.name} path={mainPath} badge={MAIN_BADGE} />}
        className={SEARCH_SECTION_CLASS}
        emptyMessage={`No matches in ${main.name}.`}
      />
      {linked.map((project) => (
        <LinkedProjectContentSearch
          key={project.id}
          project={project}
          chatId={chatId}
          paneIndex={paneIndex}
          query={results.query}
          isStale={results.isStale}
        />
      ))}
    </div>
  );
}
