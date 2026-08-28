/**
 * Every failure a client is allowed to see.
 *
 * The wire shape is `{ error: { code, message } }`, which is what Ravelon
 * desktop and iOS clients already read out of a failed response.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(400, code, message, details);

export const unauthorized = (code = 'unauthorized', message = 'Authentication required') =>
  new ApiError(401, code, message);

export const forbidden = (code: string, message: string) => new ApiError(403, code, message);

export const notFound = (code: string, message: string) => new ApiError(404, code, message);

export const conflict = (code: string, message: string) => new ApiError(409, code, message);
