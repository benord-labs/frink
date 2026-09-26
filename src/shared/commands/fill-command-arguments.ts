/** Replacer function, not a string: `$&`/`$$` inside the user's args must land verbatim. */
export function fillCommandArguments(body: string, args: string): string {
  return body.replace(/\$ARGUMENTS/g, () => args);
}
