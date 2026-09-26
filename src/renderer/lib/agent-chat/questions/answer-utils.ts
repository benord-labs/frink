/**
 * Joins picked option labels with inline "Other" text in the AskUserQuestion result format.
 * Empty or whitespace-only custom text is dropped.
 */
export function combineAnswer(picked: string[], otherText?: string): string {
  const text = otherText?.trim() ?? '';
  return [...picked, text ? `Other: ${text}` : ''].filter(Boolean).join(', ');
}

/** True when the agent supplied its own option literally labelled "Other". */
export function hasOwnOtherOption(options: ReadonlyArray<{ label: string }>): boolean {
  return options.some((option) => option.label.trim().toLowerCase() === 'other');
}
