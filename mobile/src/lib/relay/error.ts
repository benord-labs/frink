export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The link to the computer closed under a request, so asking again dials a fresh one. */
export class LinkLost extends ApiError {}

const UNREACHABLE =
  'Can’t reach your computer. Keep Frink open and your computer awake and online. If you just sent something, refresh before trying again — it may have arrived.';

export const unreachable = () => new ApiError(UNREACHABLE, 0);
export const linkLost = () => new LinkLost(UNREACHABLE, 0);
