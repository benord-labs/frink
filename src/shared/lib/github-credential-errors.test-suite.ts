import { describe, expect, it } from 'vitest';

type RunGithubCredentialErrorSuiteParams = {
  normalizeGithubCredentialErrorCode: (errorCode: string | null | undefined) => string | null;
  getGithubCredentialRemediationMessage: (errorCode: string | null | undefined) => string | null;
};

export function runGithubCredentialErrorSuite({
  normalizeGithubCredentialErrorCode,
  getGithubCredentialRemediationMessage,
}: RunGithubCredentialErrorSuiteParams): void {
  describe('normalizeGithubCredentialErrorCode', () => {
    it('maps credential-first aliases to legacy resolver codes', () => {
      expect(normalizeGithubCredentialErrorCode('MISSING_GITHUB_CREDENTIAL')).toBe('MISSING_PAT');
      expect(normalizeGithubCredentialErrorCode('INVALID_GITHUB_CREDENTIAL')).toBe('INVALID_PAT');
    });

    it('passes through existing resolver codes', () => {
      expect(normalizeGithubCredentialErrorCode('MISSING_PAT')).toBe('MISSING_PAT');
      expect(normalizeGithubCredentialErrorCode('INVALID_PAT')).toBe('INVALID_PAT');
      expect(normalizeGithubCredentialErrorCode('INSUFFICIENT_SCOPE')).toBe('INSUFFICIENT_SCOPE');
      expect(normalizeGithubCredentialErrorCode('PROJECT_OVERRIDE_NOT_FOUND')).toBe(
        'PROJECT_OVERRIDE_NOT_FOUND',
      );
      expect(normalizeGithubCredentialErrorCode('NO_EFFECTIVE_GITHUB_CREDENTIAL')).toBe(
        'NO_EFFECTIVE_GITHUB_CREDENTIAL',
      );
    });

    it('returns null for nullish or unknown codes', () => {
      expect(normalizeGithubCredentialErrorCode(null)).toBe(null);
      expect(normalizeGithubCredentialErrorCode(undefined)).toBe(null);
      expect(normalizeGithubCredentialErrorCode('UNKNOWN_CODE')).toBe(null);
    });
  });

  describe('getGithubCredentialRemediationMessage', () => {
    it('returns the same remediation for alias and legacy codes', () => {
      expect(getGithubCredentialRemediationMessage('MISSING_PAT')).toContain(
        'No GitHub cloud credential is configured',
      );
      expect(getGithubCredentialRemediationMessage('INVALID_PAT')).toContain(
        'Saved GitHub credential appears invalid',
      );
      expect(getGithubCredentialRemediationMessage('NO_EFFECTIVE_GITHUB_CREDENTIAL')).toContain(
        'No effective GitHub credential could be resolved',
      );
      expect(
        getGithubCredentialRemediationMessage(
          normalizeGithubCredentialErrorCode('NO_EFFECTIVE_GITHUB_CREDENTIAL'),
        ),
      ).toBe(getGithubCredentialRemediationMessage('NO_EFFECTIVE_GITHUB_CREDENTIAL'));
      expect(getGithubCredentialRemediationMessage('MISSING_GITHUB_CREDENTIAL')).toBe(
        getGithubCredentialRemediationMessage('MISSING_PAT'),
      );
      expect(getGithubCredentialRemediationMessage('INVALID_GITHUB_CREDENTIAL')).toBe(
        getGithubCredentialRemediationMessage('INVALID_PAT'),
      );
    });

    it('returns null for nullish or unknown codes', () => {
      expect(getGithubCredentialRemediationMessage(null)).toBe(null);
      expect(getGithubCredentialRemediationMessage(undefined)).toBe(null);
      expect(getGithubCredentialRemediationMessage('UNKNOWN_CODE')).toBe(null);
    });
  });
}
