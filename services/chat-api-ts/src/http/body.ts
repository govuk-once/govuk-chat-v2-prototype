import { z } from 'zod';

export type ParseJsonResult =
  { success: true; data: unknown } | { success: false };

export function parseRequestBody(
  rawBody: string | null | undefined,
): ParseJsonResult {
  try {
    return { success: true, data: rawBody ? JSON.parse(rawBody) : {} };
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return { success: false };
  }
}

export type ValidateBodyResult<T> =
  | { success: true; data: T }
  | { success: false; details: z.ZodFlattenedError<T> };

export function validateRequestBody<T>(
  data: unknown,
  schema: z.ZodType<T>,
): ValidateBodyResult<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      success: false,
      details: z.flattenError(result.error) as z.ZodFlattenedError<T>,
    };
  }

  return { success: true, data: result.data };
}
