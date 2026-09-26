type TaskUtils = {
  tasks: {
    listPaginated: { invalidate: () => void };
    listCounts: { invalidate: () => void };
    getById: { invalidate: () => void };
    getDrivingTaskForSubChat: { invalidate: () => void };
    getActionableTaskForSubChat: { invalidate: () => void };
  };
};

export function getTaskRefetchInterval(status: string | undefined): number | false {
  // Plan-review states can poll less aggressively than live execution.
  if (status === 'plan_ready') {
    return 10000;
  }

  if (
    status === 'done' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'needs_attention' ||
    status === undefined
  ) {
    return false;
  }
  return 5000;
}

export function invalidateTaskQueries(utils: TaskUtils): void {
  utils.tasks.listPaginated.invalidate();
  utils.tasks.listCounts.invalidate();
  utils.tasks.getById.invalidate();
  // ParkAnswerSurface reads the driving task via this query; invalidate it on the same triggers so
  // the parked-question card appears when a later flow node parks at needs_attention.
  utils.tasks.getDrivingTaskForSubChat.invalidate();
  // TaskAcceptBar + TaskControls (the chat-level status rows) read their acting task via this.
  utils.tasks.getActionableTaskForSubChat.invalidate();
}
