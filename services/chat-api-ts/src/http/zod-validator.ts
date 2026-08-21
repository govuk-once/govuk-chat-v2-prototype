import type { MiddlewareObj, Request } from '@middy/core';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { z } from 'zod';
import { buildJsonErrorResponse, type JsonErrorResponse } from './errors.ts';

export type ValidatedBodyEvent<T> = Omit<APIGatewayProxyEvent, 'body'> & {
  body: T;
};

export type ValidatedHeadersEvent<T> = Omit<APIGatewayProxyEvent, 'headers'> & {
  headers: T;
};

function validateAgainstSchema<S extends z.ZodType>(
  value: unknown,
  schema: S,
  errorMessage: string,
): { data: z.infer<S> } | { response: JsonErrorResponse } {
  const result = schema.safeParse(value);
  if (!result.success) {
    return {
      response: buildJsonErrorResponse(422, {
        error: errorMessage,
        details: z.flattenError(result.error),
      }),
    };
  }

  return { data: result.data };
}

/**
 * Validates the request body against `schema`, replacing it with the parsed
 * data. The returned event type tells middy the body is parsed, so a handler
 * added with `.handler()` after this middleware sees it as `z.infer<T>`.
 */
export function zodBodyValidator<T extends z.ZodType>(
  schema: T,
): MiddlewareObj<ValidatedBodyEvent<z.infer<T>>> {
  return {
    before: (request: Request<ValidatedBodyEvent<z.infer<T>>>) => {
      const result = validateAgainstSchema(
        request.event.body ?? {},
        schema,
        'Invalid request body',
      );
      if ('response' in result) return result.response;

      request.event.body = result.data;
    },
  };
}

/**
 * Validates the request headers against `schema`. See zodBodyValidator for how
 * the returned event type flows through to the handler.
 */
export function zodHeadersValidator<
  T extends z.ZodType<Record<string, string>>,
>(schema: T): MiddlewareObj<ValidatedHeadersEvent<z.infer<T>>> {
  return {
    before: (request: Request<ValidatedHeadersEvent<z.infer<T>>>) => {
      const result = validateAgainstSchema(
        request.event.headers ?? {},
        schema,
        'Invalid request headers',
      );
      if ('response' in result) return result.response;

      // Merged rather than replaced so headers this schema doesn't describe
      // survive: middleware further down the chain still needs them, most
      // notably httpJsonBodyParser reading content-type.
      request.event.headers = { ...request.event.headers, ...result.data };
    },
  };
}
