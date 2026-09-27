export class MobileApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'MobileApiError';
  }
}
