import { shellInterpolationContextAt } from './quote-context';

type ShellTemplateNode = {
  id: string;
  blockType: string;
  config?: Record<string, unknown>;
};

const TEMPLATE_PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

function blankPathWarningMessage(placeholder: string): string {
  return `Template variable ${placeholder} sits next to a path separator. If it resolves to an empty value the path collapses (e.g. /tmp/work/${placeholder} becomes /tmp/work/) and the command still runs. Assign it first and let the shell stop on a blank value: v=${placeholder}; rm -rf "/tmp/work/\${v:?}".`;
}

/** Design-time warnings for run_command placeholders beside a `/`, where a blank value runs anyway
 *  (flow-unresolved-placeholder-rendering). `uncertain` contexts are never substituted, so skipped. */
export function findBlankPathShellTemplateWarnings(nodes: ShellTemplateNode[]): Array<{
  nodeId: string;
  field: string;
  placeholder: string;
  message: string;
  shellHazard: 'blank-path';
}> {
  return nodes.flatMap((node) => {
    const command = node.blockType === 'run_command' ? node.config?.command : undefined;
    if (typeof command !== 'string') return [];
    const found = new Set<string>();
    for (const match of command.matchAll(TEMPLATE_PLACEHOLDER)) {
      const path = match[1]?.trim();
      if (!path) continue;
      const end = match.index + match[0].length;
      if (command[match.index - 1] !== '/' && command[end] !== '/') continue;
      if (shellInterpolationContextAt(command, match.index, match[0].length) === 'uncertain') {
        continue;
      }
      found.add(`{{${path}}}`);
    }
    return [...found].map((placeholder) => ({
      nodeId: node.id,
      field: 'command',
      placeholder,
      shellHazard: 'blank-path' as const,
      message: blankPathWarningMessage(placeholder),
    }));
  });
}
