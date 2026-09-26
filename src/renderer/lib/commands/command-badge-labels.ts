import type { SlashCommandOption } from './types';

/** A vendor plugin's template is neither user nor project scope, so it gets its own label. */
function originLabel(option: SlashCommandOption): 'plugin' | 'project' | 'user' {
  if (option.origin === 'plugin') return 'plugin';
  return option.source === 'project' ? 'project' : 'user';
}

/** Row badges left to right: the argument marker, then the origin. */
export function commandBadgeLabels(option: SlashCommandOption): string[] {
  const labels = option.takesArguments ? [option.argumentHint?.trim() || 'args'] : [];
  if (option.category === 'repository' && option.origin !== 'frink')
    labels.push(originLabel(option));
  return labels;
}
