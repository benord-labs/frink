import {
  getGithubCredentialRemediationMessage,
  normalizeGithubCredentialErrorCode,
} from './github-credential-errors';
import { runGithubCredentialErrorSuite } from './github-credential-errors.test-suite';

runGithubCredentialErrorSuite({
  normalizeGithubCredentialErrorCode,
  getGithubCredentialRemediationMessage,
});
