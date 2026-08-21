import type { MiddlewareObj, Request } from '@middy/core';
import type { z } from 'zod';

export type FlattenedError = ReturnType<typeof z.flattenError>;

export interface SimpleErrorBody {
  error: string;
}

export interface ValidationErrorBody {
  error: string;
  details: FlattenedError;
}

export type ErrorBody = SimpleErrorBody | ValidationErrorBody;

export interface JsonErrorResponse {
  statusCode: number;
  headers: { 'Content-Type': 'application/json' };
  body: string;
}

export function buildJsonErrorResponse(
  statusCode: number,
  body: ErrorBody,
): JsonErrorResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

interface HttpErrorLike {
  statusCode?: number;
  message?: string;
  expose?: boolean;
}

/**
 * Renders anything thrown in the middy chain as a JSON error response, so
 * clients get one error shape regardless of which middleware rejected the
 * request. Errors carrying no status code, or marked not to be exposed, are
 * reported as a generic 500 rather than leaking their message.
 */
export function jsonHttpErrorHandler(): MiddlewareObj<unknown> {
  return {
    onError: (request: Request<unknown>) => {
      // Something earlier in the chain already produced a response, so the
      // error has been handled and shouldn't be overwritten.
      if (request.response !== undefined) return;

      // TODO: Log the error here once this service has a logger.
      const error = (request.error ?? {}) as HttpErrorLike;
      const statusCode = error.statusCode ?? 500;
      const isExposable = error.expose ?? statusCode < 500;

      return buildJsonErrorResponse(statusCode, {
        error:
          isExposable && error.message
            ? error.message
            : 'Internal server error',
      });
    },
  };
}
