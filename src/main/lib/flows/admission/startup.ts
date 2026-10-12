import '../start';
import { captureFlowAdmissionException } from './activity';
import { recoverFlowAdmissions } from './runtime';
import './terminal-resume/dispatcher';

export async function recoverFlowAdmissionsAtStartup(): Promise<void> {
  try {
    await recoverFlowAdmissions();
    // Recovery drops a Retry claim the dead process never promoted. A stage held open for that
    // Retry gets no terminal event, and the earlier batch sweep ran while the claim was still live.
    const { recoverBatchStages } = await import('../batch-dispatch');
    await recoverBatchStages();
  } catch (error) {
    captureFlowAdmissionException(error, 'startup-recovery');
    throw error;
  }
}
