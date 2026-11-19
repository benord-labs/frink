import { type BundledLanguage, bundledLanguages } from 'shiki';

/** Monaco ids whose Shiki grammar has another name. */
const SHIKI_ID = new Map<string, BundledLanguage>([
  // Monaco's TS worker attaches only to 'typescript', so .tsx shares it; the tsx grammar colours JSX.
  ['typescript', 'tsx'],
  ['javascript', 'jsx'],
  ['restructuredtext', 'rst'],
  ['sol', 'solidity'],
  ['systemverilog', 'system-verilog'],
  ['mysql', 'sql'],
  ['pgsql', 'sql'],
  ['redshift', 'sql'],
]);

/** The Shiki grammar for a Monaco language id, or undefined to keep Monaco's own tokenizer. */
export function shikiLanguageFor(monacoId: string): BundledLanguage | undefined {
  const renamed = SHIKI_ID.get(monacoId);
  if (renamed) return renamed;
  // SAFETY: the `in` check proves monacoId is a key of bundledLanguages.
  return monacoId in bundledLanguages ? (monacoId as BundledLanguage) : undefined;
}
