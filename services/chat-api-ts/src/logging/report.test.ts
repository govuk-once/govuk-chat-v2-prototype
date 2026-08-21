import { describe, expect, it, vi } from 'vitest';

const { error, warn } = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@aws-lambda-powertools/logger', () => ({
  Logger: vi.fn().mockImplementation(function () {
    return { error, warn };
  }),
}));

import { reportError, reportWarning } from './report.ts';

describe('reportError', () => {
  it('logs the message at error level with the given context', () => {
    const cause = new Error('boom');

    reportError('Something failed', { error: cause, threadId: 'thread-1' });

    expect(error).toHaveBeenCalledWith('Something failed', {
      error: cause,
      threadId: 'thread-1',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('defaults context to an empty object when none is given', () => {
    reportError('Something failed');

    expect(error).toHaveBeenCalledWith('Something failed', {});
  });
});

describe('reportWarning', () => {
  it('logs the message at warn level so it does not read as a fault of ours', () => {
    const cause = new Error('bad request');

    reportWarning('Request was rejected', { error: cause });

    expect(warn).toHaveBeenCalledWith('Request was rejected', { error: cause });
    expect(error).not.toHaveBeenCalled();
  });

  it('defaults context to an empty object when none is given', () => {
    reportWarning('Request was rejected');

    expect(warn).toHaveBeenCalledWith('Request was rejected', {});
  });
});
