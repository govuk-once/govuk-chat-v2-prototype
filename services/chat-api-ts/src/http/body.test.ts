import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseRequestBody, validateRequestBody } from './body.ts';

describe('parseRequestBody', () => {
  it('returns parsed data for valid JSON', () => {
    const result = parseRequestBody('{"name":"Alice"}');

    expect(result).toEqual({ success: true, data: { name: 'Alice' } });
  });

  it('returns failure for invalid JSON', () => {
    const result = parseRequestBody('{not valid json');

    expect(result).toEqual({ success: false });
  });

  it('treats undefined body as empty object', () => {
    const result = parseRequestBody(undefined);

    expect(result).toEqual({ success: true, data: {} });
  });

  it('re-throws non-SyntaxError exceptions', () => {
    const badBody = {
      toString() {
        throw new TypeError('unexpected');
      },
    };

    expect(() => parseRequestBody(badBody as unknown as string)).toThrow(
      TypeError,
    );
  });
});

const TestSchema = z.object({
  name: z.string().min(1),
  age: z.number(),
});

describe('validateRequestBody', () => {
  it('returns parsed data when input matches the schema', () => {
    const result = validateRequestBody({ name: 'Alice', age: 30 }, TestSchema);

    expect(result).toEqual({ success: true, data: { name: 'Alice', age: 30 } });
  });

  it('returns field errors when input fails validation', () => {
    const result = validateRequestBody(
      { name: '', age: 'not-a-number' },
      TestSchema,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.details.fieldErrors).toHaveProperty('name');
      expect(result.details.fieldErrors).toHaveProperty('age');
    }
  });

  it('returns field errors for missing required fields', () => {
    const result = validateRequestBody({}, TestSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.details.fieldErrors).toHaveProperty('name');
      expect(result.details.fieldErrors).toHaveProperty('age');
    }
  });
});
