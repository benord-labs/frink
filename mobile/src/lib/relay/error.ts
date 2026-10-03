export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const unreachable = () =>
  new ApiError(
    'Can’t reach your Mac. Keep Frink open and your Mac awake and online. If you just sent something, refresh before trying again — it may have arrived.',
    0,
  );
