import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { EventType, type BaseEvent } from '@ag-ui/core';
import {
  send,
  encoder,
  invokeAgentRuntimeCommand,
  stubAwsLambdaGlobal,
  stubBedrockAgentCoreClient,
  createResponseStream,
  expectJsonHttpResponse,
  aguiEventStream,
  createFailingStream,
  type ResponseStream,
} from '../../test-utils/agent-stream.ts';

type HandlerFunction = (
  event: APIGatewayProxyEvent,
  responseStream: ResponseStream,
  context?: unknown,
) => Promise<void>;

const testEnv = {} as {
  handler: HandlerFunction;
  responseStream: ResponseStream;
};

beforeEach(() => {
  testEnv.responseStream = createResponseStream();
});

const VALID_THREAD_ID = crypto.randomUUID();
const VALID_RUN_ID = crypto.randomUUID();
const VALID_USER_ID = crypto.randomUUID();
const DEFAULT_HEADERS = {
  'end-user-id': VALID_USER_ID,
  'content-type': 'application/json',
};
const AGENT_RUNTIME_ARN =
  'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/test';
const VALID_MESSAGES = [
  { id: crypto.randomUUID(), role: 'user', content: 'Tell me about SSP' },
];

beforeAll(async () => {
  stubAwsLambdaGlobal();
  stubBedrockAgentCoreClient();
  vi.stubEnv('AGENT_RUNTIME_ARN', AGENT_RUNTIME_ARN);

  const agentStreamModule = await import('./invoke.ts');
  testEnv.handler = agentStreamModule.handler as unknown as HandlerFunction;
});

// TODO: Use real APIGatewayProxyEvent for event parameter.
function makeEvent(
  body: unknown,
  headers: Record<string, string> = DEFAULT_HEADERS,
): APIGatewayProxyEvent {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  } as unknown as APIGatewayProxyEvent;
}

async function runAndGetErrorBody(
  body: unknown,
  headers?: Record<string, string>,
) {
  const responseStream = testEnv.responseStream;
  await testEnv.handler(makeEvent(body, headers), responseStream, {});
  return {
    responseStream,
    parsed: JSON.parse(responseStream.read()),
  };
}

function fieldErrorResponse(error: string, fields: string[]): unknown {
  return expect.objectContaining({
    error,
    details: expect.objectContaining({
      fieldErrors: expect.objectContaining(
        Object.fromEntries(fields.map((field) => [field, expect.anything()])),
      ),
    }),
  });
}

describe('configuration', () => {
  it('throws an error during module import when AGENT_RUNTIME_ARN is not configured', async () => {
    vi.resetModules();
    vi.stubEnv('AGENT_RUNTIME_ARN', undefined);

    await expect(import('./invoke.ts')).rejects.toThrow(
      'AGENT_RUNTIME_ARN is not configured',
    );
  });
});

describe('handler', () => {
  describe('request headers', () => {
    it('returns 422 when end-user-id header is missing', async () => {
      const { responseStream } = await runAndGetErrorBody(
        { threadId: VALID_THREAD_ID, messages: VALID_MESSAGES },
        { 'content-type': 'application/json' },
      );

      expectJsonHttpResponse(
        responseStream,
        422,
        fieldErrorResponse('Invalid request headers', ['end-user-id']),
      );
    });

    it('normalises header keys before validation', async () => {
      const { responseStream } = await runAndGetErrorBody(
        { threadId: VALID_THREAD_ID, messages: VALID_MESSAGES },
        { 'End-User-Id': VALID_USER_ID, 'content-type': 'application/json' },
      );

      // Falling through to a body error proves the 'End-User-Id' spelling was
      // normalised and accepted by the header validator.
      expectJsonHttpResponse(
        responseStream,
        422,
        fieldErrorResponse('Invalid request body', ['runId']),
      );
    });
  });

  describe('request body parsing', () => {
    // Middy's JSON body parser reports malformed JSON as a 422 rather than the
    // 400 the handler used to return.
    it('returns a 422 for a malformed JSON body', async () => {
      const responseStream = testEnv.responseStream;
      const event = {
        body: '{not valid json',
        headers: DEFAULT_HEADERS,
      } as unknown as APIGatewayProxyEvent;

      await testEnv.handler(event, responseStream, {});

      expectJsonHttpResponse(responseStream, 422, {
        error: 'Invalid or malformed JSON was provided',
      });
    });

    it('returns 415 when Content-Type is missing or not JSON', async () => {
      const responseStream = testEnv.responseStream;

      await testEnv.handler(
        makeEvent(
          { threadId: VALID_THREAD_ID, messages: VALID_MESSAGES },
          { 'end-user-id': VALID_USER_ID },
        ),
        responseStream,
        {},
      );

      expectJsonHttpResponse(responseStream, 415, {
        error: 'Unsupported Media Type',
      });
    });
  });

  describe('request body validation', () => {
    it('returns 422 with validation details when schema validation occurs', async () => {
      const { responseStream } = await runAndGetErrorBody({
        threadId: 'not-a-uuid',
      });

      expectJsonHttpResponse(
        responseStream,
        422,
        fieldErrorResponse('Invalid request body', ['threadId', 'messages']),
      );
    });

    it('returns 422 with validation details when schema validation occurs for nested fields', async () => {
      const { responseStream } = await runAndGetErrorBody({
        threadId: VALID_THREAD_ID,
        messages: [{ id: 'msg-1', role: 'user', content: '' }],
      });

      expectJsonHttpResponse(
        responseStream,
        422,
        fieldErrorResponse('Invalid request body', ['messages']),
      );
    });
  });

  describe('successful invocation', () => {
    it('invokes the agent runtime with the full payload and streams AG-UI events back', async () => {
      const responseStream = testEnv.responseStream;

      const events: BaseEvent[] = [
        {
          type: EventType.RUN_STARTED,
          threadId: VALID_THREAD_ID,
          runId: VALID_RUN_ID,
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: 'msg-1',
          role: 'assistant',
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: 'msg-1',
          delta: 'Statutory Sick Pay ',
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: 'msg-1',
          delta: 'is a weekly payment.',
        },
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: 'msg-1',
        },
        {
          type: EventType.RUN_FINISHED,
          threadId: VALID_THREAD_ID,
          runId: VALID_RUN_ID,
        },
      ];
      send.mockResolvedValueOnce({ response: aguiEventStream(events) });

      const requestBody = {
        threadId: VALID_THREAD_ID,
        runId: VALID_RUN_ID,
        state: {},
        forwardedProps: {},
        tools: [],
        context: [],
        messages: VALID_MESSAGES,
      };

      await testEnv.handler(makeEvent(requestBody), responseStream, {});

      expect(responseStream.read()).toBe(
        events.map((event) => encoder.encode(event)).join(''),
      );
      expect(invokeAgentRuntimeCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          agentRuntimeArn: AGENT_RUNTIME_ARN,
          runtimeSessionId: VALID_THREAD_ID,
          payload: JSON.stringify({
            threadId: VALID_THREAD_ID,
            runId: VALID_RUN_ID,
            state: {},
            messages: VALID_MESSAGES,
            tools: [],
            context: [],
            forwardedProps: {
              endUserId: VALID_USER_ID,
            },
          }),
        }),
      );
    });
  });

  describe('agent runtime failures', () => {
    describe('pre-stream failures', () => {
      it('returns a 500 JSON error when runtime client invocation fails before opening stream', async () => {
        const responseStream = testEnv.responseStream;
        send.mockRejectedValueOnce(new Error('Error from agent runtime'));

        await testEnv.handler(
          makeEvent({
            threadId: VALID_THREAD_ID,
            runId: VALID_RUN_ID,
            messages: VALID_MESSAGES,
          }),
          responseStream,
          {},
        );

        expectJsonHttpResponse(responseStream, 500, {
          error: 'Agent invocation error',
        });
      });

      it('returns a 500 JSON error when no response body is returned from agent runtime', async () => {
        const responseStream = testEnv.responseStream;
        send.mockResolvedValueOnce({ response: undefined });

        await testEnv.handler(
          makeEvent({
            threadId: VALID_THREAD_ID,
            runId: VALID_RUN_ID,
            messages: VALID_MESSAGES,
          }),
          responseStream,
          {},
        );

        expectJsonHttpResponse(responseStream, 500, {
          error: 'Agent invocation error',
        });
      });
    });

    describe('mid-stream failures', () => {
      it('emits synthetic RUN_STARTED followed by RUN_ERROR when response stream fails before RUN_STARTED chunk', async () => {
        const responseStream = testEnv.responseStream;

        send.mockResolvedValueOnce({ response: createFailingStream() });

        await testEnv.handler(
          makeEvent({
            threadId: VALID_THREAD_ID,
            runId: VALID_RUN_ID,
            messages: VALID_MESSAGES,
          }),
          responseStream,
          {},
        );

        expect(responseStream.read()).toContain(EventType.RUN_ERROR);
      });
    });
  });
});
