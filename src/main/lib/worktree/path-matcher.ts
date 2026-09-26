import {
  isRootLikePath,
  normalizePathSlashes,
  trimTrailingSlashes,
} from '../../../shared/lib/path-normalization';

export function getMatchedWorktreeBasePath(
  pathToResolve: string,
  configuredBasePath: string,
  legacyBasePath: string,
): string | null {
  const normalizedPath = normalizePathSlashes(pathToResolve);
  let candidateBases = [...new Set([configuredBasePath, legacyBasePath])].map((candidate) =>
    trimTrailingSlashes(normalizePathSlashes(candidate)),
  );
  candidateBases = candidateBases.filter((base) => !isRootLikePath(base));

  if (candidateBases.length === 0) {
    return null;
  }

  return (
    candidateBases.find(
      (base) => normalizedPath === base || normalizedPath.startsWith(`${base}/`),
    ) ?? null
  );
}
