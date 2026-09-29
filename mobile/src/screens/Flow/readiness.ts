/** The smallest overview the computer can send: Flow and run screens only need `executionReady`. */
export const READINESS = {
  type: 'overview',
  limits: { attention: 1, running: 1, inbox: 1 },
} as const;
