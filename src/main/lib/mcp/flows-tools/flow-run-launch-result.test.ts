import { describe, expect, it } from 'vitest';
import type { DbFlowRun } from '../../flows/mcp-cloud-shim';
import { buildFlowRunLaunchResult } from './flow-run-launch-result';

const baseRun: DbFlowRun = {
  id: 'run-1',
  flow_version_id: 'version-1',
  status: 'running',
  admission_state: 'active',
  queue_position: null,
  trigger_context: null,
  idempotency_key: null,
  started_at: '2026-08-03T10:00:00.000Z',
  completed_at: null,
  created_at: '2026-08-03T10:00:00.000Z',
};

describe('buildFlowRunLaunchResult', () => {
  it('reports a promoted run as started', () => {
    expect(buildFlowRunLaunchResult('flow-1', baseRun)).toMatchObject({
      isError: false,
      body: {
        success: true,
        flowRunId: 'run-1',
        status: 'started',
        runStatus: 'running',
        admissionState: 'active',
        queuePosition: null,
        message: 'Flow run started. The user can monitor progress in the Flows page → Run history.',
      },
    });
  });

  it('reports a pending admission as queued with its position', () => {
    expect(
      buildFlowRunLaunchResult('flow-1', {
        ...baseRun,
        status: 'pending',
        started_at: null,
        admission_state: 'queued',
        queue_position: 3,
      }),
    ).toMatchObject({
      isError: false,
      body: {
        success: true,
        status: 'queued',
        runStatus: 'pending',
        admissionState: 'queued',
        queuePosition: 3,
        message:
          'Flow run queued at position #3. The user can monitor progress in the Flows page → Run history.',
      },
    });
  });

  it('reports a terminal pre-start run as not started', () => {
    expect(
      buildFlowRunLaunchResult('flow-1', {
        ...baseRun,
        status: 'cancelled',
        started_at: null,
        admission_state: null,
      }),
    ).toMatchObject({
      isError: true,
      body: {
        success: false,
        status: 'not_started',
        runStatus: 'cancelled',
        queuePosition: null,
        message: 'Flow run did not start (cancelled).',
      },
    });
  });
});
