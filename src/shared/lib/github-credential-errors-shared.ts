type ResolverGithubCredentialErrorCode =
  | 'MISSING_PAT'
  | 'INVALID_PAT'
  | 'INSUFFICIENT_SCOPE'
  | 'PROJECT_OVERRIDE_NOT_FOUND'
  | 'NO_EFFECTIVE_GITHUB_CREDENTIAL';

export type GithubCredentialErrorCode =
  | ResolverGithubCredentialErrorCode
  | 'MISSING_GITHUB_CREDENTIAL'
  | 'INVALID_GITHUB_CREDENTIAL';

const CREDENTIAL_ERROR_ALIAS_MAP: Record<
  GithubCredentialErrorCode,
  ResolverGithubCredentialErrorCode
> = {
  MISSING_PAT: 'MISSING_PAT',
  INVALID_PAT: 'INVALID_PAT',
  INSUFFICIENT_SCOPE: 'INSUFFICIENT_SCOPE',
  PROJECT_OVERRIDE_NOT_FOUND: 'PROJECT_OVERRIDE_NOT_FOUND',
  NO_EFFECTIVE_GITHUB_CREDENTIAL: 'NO_EFFECTIVE_GITHUB_CREDENTIAL',
  MISSING_GITHUB_CREDENTIAL: 'MISSING_PAT',
  INVALID_GITHUB_CREDENTIAL: 'INVALID_PAT',
};

const REMEDIATION_MESSAGE_BY_CODE: Record<ResolverGithubCredentialErrorCode, string> = {
  MISSING_PAT:
    'No GitHub cloud credential is configured for cloud git tasks. Add one in Settings > AI providers.',
  PROJECT_OVERRIDE_NOT_FOUND:
    'This project points to a removed GitHub credential. Re-select one in project settings.',
  INVALID_PAT:
    'Saved GitHub credential appears invalid. Re-connect GitHub or save a working token in Settings > AI providers.',
  INSUFFICIENT_SCOPE:
    'Saved GitHub credential lacks required permissions for cloud git or pull request operations. Update it in Settings > AI providers.',
  NO_EFFECTIVE_GITHUB_CREDENTIAL:
    'No effective GitHub credential could be resolved. Set a default credential or project override in Settings > AI providers.',
};

export function normalizeGithubCredentialErrorCode(
  errorCode: string | null | undefined,
): ResolverGithubCredentialErrorCode | null {
  if (!errorCode) {
    return null;
  }

  return CREDENTIAL_ERROR_ALIAS_MAP[errorCode as GithubCredentialErrorCode] ?? null;
}

export function getGithubCredentialRemediationMessage(
  errorCode: string | null | undefined,
): string | null {
  const normalizedCode = normalizeGithubCredentialErrorCode(errorCode);
  if (!normalizedCode) {
    return null;
  }

  return REMEDIATION_MESSAGE_BY_CODE[normalizedCode] ?? null;
}
