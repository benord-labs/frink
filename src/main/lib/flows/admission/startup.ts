import '../start';
import { captureFlowAdmissionException } from './activity';
import { recoverFlowAdmissions } from './runtime';
import './terminal-resume/dispatcher';

export async function recoverFlowAdmissionsAtStartup(): Promise<void> {
  try {
    await recoverFlowAdmissions();
  } catch (error) {
    captureFlowAdmissionException(error, 'startup-recovery');
    throw error;
  }
}
