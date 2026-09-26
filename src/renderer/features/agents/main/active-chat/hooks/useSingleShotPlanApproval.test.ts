// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useSingleShotPlanApproval } from './useSingleShotPlanApproval';

describe('useSingleShotPlanApproval', () => {
  it('prevents duplicate approval while lock is active', () => {
    const onApprove = vi.fn();
    const { result } = renderHook(() =>
      useSingleShotPlanApproval({
        isStreaming: false,
        hasUnapprovedPlan: true,
        onApprove,
      }),
    );

    act(() => {
      result.current.handleApprovePlanSingleShot();
      result.current.handleApprovePlanSingleShot();
    });

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(result.current.isApprovingPlan).toBe(true);
  });

  it('clears lock when streaming starts and allows approval again', () => {
    const onApprove = vi.fn();
    const { result, rerender } = renderHook(
      (props: { isStreaming: boolean; hasUnapprovedPlan: boolean }) =>
        useSingleShotPlanApproval({
          isStreaming: props.isStreaming,
          hasUnapprovedPlan: props.hasUnapprovedPlan,
          onApprove,
        }),
      { initialProps: { isStreaming: false, hasUnapprovedPlan: true } },
    );

    act(() => {
      result.current.handleApprovePlanSingleShot();
    });
    expect(onApprove).toHaveBeenCalledTimes(1);

    rerender({ isStreaming: true, hasUnapprovedPlan: true });
    expect(result.current.isApprovingPlan).toBe(false);

    rerender({ isStreaming: false, hasUnapprovedPlan: true });
    act(() => {
      result.current.handleApprovePlanSingleShot();
    });

    expect(onApprove).toHaveBeenCalledTimes(2);
  });

  it('clears lock when hasUnapprovedPlan flips to false', () => {
    const onApprove = vi.fn();
    const { result, rerender } = renderHook(
      (props: { isStreaming: boolean; hasUnapprovedPlan: boolean }) =>
        useSingleShotPlanApproval({
          isStreaming: props.isStreaming,
          hasUnapprovedPlan: props.hasUnapprovedPlan,
          onApprove,
        }),
      { initialProps: { isStreaming: false, hasUnapprovedPlan: true } },
    );

    act(() => {
      result.current.handleApprovePlanSingleShot();
    });

    rerender({ isStreaming: false, hasUnapprovedPlan: false });

    expect(result.current.isApprovingPlan).toBe(false);
  });

  it('resets lock when approval throws synchronously', () => {
    const onApprove = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        throw new Error('sync failure');
      })
      .mockImplementation(() => {});

    const { result } = renderHook(() =>
      useSingleShotPlanApproval({
        isStreaming: false,
        hasUnapprovedPlan: true,
        onApprove,
      }),
    );

    act(() => {
      result.current.handleApprovePlanSingleShot();
    });
    expect(result.current.isApprovingPlan).toBe(false);

    act(() => {
      result.current.handleApprovePlanSingleShot();
    });

    expect(onApprove).toHaveBeenCalledTimes(2);
    expect(result.current.isApprovingPlan).toBe(true);
  });

  it('resets lock when approval rejects asynchronously', async () => {
    const onApprove = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('async failure'))
      .mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useSingleShotPlanApproval({
        isStreaming: false,
        hasUnapprovedPlan: true,
        onApprove,
      }),
    );

    act(() => {
      result.current.handleApprovePlanSingleShot();
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.isApprovingPlan).toBe(false);

    act(() => {
      result.current.handleApprovePlanSingleShot();
    });

    expect(onApprove).toHaveBeenCalledTimes(2);
    expect(result.current.isApprovingPlan).toBe(true);
  });
});
