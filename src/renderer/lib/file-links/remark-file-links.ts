import {
  bareFileNameTarget,
  type FileLinkTarget,
  inlineCodeFileTarget,
  parseFileLinkTarget,
} from './file-link-target';

/** The element a file link or path-shaped inline code becomes; its only child is the original node. */
export const FILE_LINK_ELEMENT = 'frink-file';

// Structural slice of an mdast node: only the fields read or written here.
type MarkdownNode = {
  type: string;
  url?: string;
  value?: string;
  children?: MarkdownNode[];
  data?: object;
};

function nodeText(node: MarkdownNode): string {
  return node.value ?? (node.children ?? []).map(nodeText).join('');
}

function fileTargetOf(node: MarkdownNode): FileLinkTarget | null {
  if (node.type === 'link') return parseFileLinkTarget(node.url ?? '');
  if (node.type !== 'inlineCode') return null;
  return inlineCodeFileTarget(node.value ?? '') ?? bareFileNameTarget(node.value ?? '');
}

// Runs before sanitising, while a link still holds the destination its author wrote.
// Nothing inside a link is read, so code in a web link never becomes a badge.
function wrapFileReferences(node: MarkdownNode): void {
  node.children?.forEach((child, index, siblings) => {
    const target = fileTargetOf(child);
    if (target) {
      const hProperties = {
        dataPath: target.path,
        dataLine: target.line,
        dataLabel: nodeText(child),
      };
      const data = { hName: FILE_LINK_ELEMENT, hProperties };
      siblings[index] = { type: 'frinkFile', children: [child], data };
    } else if (child.type !== 'link' && child.type !== 'linkReference') {
      wrapFileReferences(child);
    }
  });
}

/** Remark plugin that marks file links, path-shaped inline code and bare file names as file references. */
export function remarkFileLinks(): (tree: MarkdownNode) => void {
  return wrapFileReferences;
}
