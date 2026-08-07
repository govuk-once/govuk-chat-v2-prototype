import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';

const send = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(function () {
    return { send };
  }),
  InvokeAgentRuntimeCommand: vi.fn().mockImplementation(function (
    input: unknown,
  ) {
    return { input };
  }),
}));

function createResponseStream() {
  const stream = {
    write: vi.fn(),
    end: vi.fn(),
  };
  return stream;
}

function writtenText(stream: ReturnType<typeof createResponseStream>): string {
  return stream.write.mock.calls
    .map(([chunk]) =>
      Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk),
    )
    .join('');
}

async function* asyncChunks(chunks: string[]) {
  for (const chunk of chunks) {
    yield Buffer.from(chunk);
  }
}

type HandlerFunction = (
  event: APIGatewayProxyEvent,
  responseStream: ReturnType<typeof createResponseStream>,
  context?: unknown,
) => Promise<void>;

const testEnv = {} as { handler: HandlerFunction };

const VALID_THREAD_ID = '12345678-1234-4234-8234-123456789012';
const VALID_RUN_ID = '87654321-4321-4321-8321-210987654321';
const VALID_USER_ID = 'user-abc-123';
const DEFAULT_HEADERS = { 'end-user-id': VALID_USER_ID };

const VALID_MESSAGES = [
  { id: 'msg-1', role: 'user' as const, content: 'Tell me about SSP' },
];

beforeAll(async () => {
  vi.stubGlobal('awslambda', {
    streamifyResponse: (function_: unknown) => function_,
    HttpResponseStream: {
      from: (
        responseStream: ReturnType<typeof createResponseStream>,
        _metadata: { statusCode: number; headers?: Record<string, string> },
      ) => responseStream,
    },
  });

  const agentStreamModule = await import('./agent-stream.ts');
  testEnv.handler = agentStreamModule.handler as unknown as HandlerFunction;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  delete process.env.AGENT_RUNTIME_ARN;
});

function makeEvent(
  body: unknown,
  headers: Record<string, string> = DEFAULT_HEADERS,
): APIGatewayProxyEvent {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  } as unknown as APIGatewayProxyEvent;
}

describe('handler', () => {
  it('returns 500 JSON when AGENT_RUNTIME_ARN is not configured', async () => {
    const responseStream = createResponseStream();

    await testEnv.handler(
      makeEvent({ thread_id: VALID_THREAD_ID, messages: VALID_MESSAGES }),
      responseStream,
      {},
    );

    expect(JSON.parse(writtenText(responseStream))).toEqual({
      error: 'AGENT_RUNTIME_ARN is not configured',
    });
    expect(responseStream.end).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 400 when end-user-id header is missing', async () => {
    process.env.AGENT_RUNTIME_ARN =
      'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/test';
    const responseStream = createResponseStream();

    await testEnv.handler(
      makeEvent({ thread_id: VALID_THREAD_ID, messages: VALID_MESSAGES }, {}),
      responseStream,
      {},
    );

    const body = JSON.parse(writtenText(responseStream));
    expect(body.error).toBe('Invalid request headers');
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'end-user-id' }),
      ]),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 400 JSON for invalid JSON body', async () => {
    process.env.AGENT_RUNTIME_ARN =
      'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/test';
    const responseStream = createResponseStream();
    const event = {
      body: '{not valid json',
      headers: DEFAULT_HEADERS,
    } as unknown as APIGatewayProxyEvent;

    await testEnv.handler(event, responseStream, {});

    expect(JSON.parse(writtenText(responseStream))).toEqual({
      error: 'Invalid JSON in request body',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 400 when thread_id is missing or not a UUID', async () => {
    process.env.AGENT_RUNTIME_ARN =
      'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/test';
    const responseStream = createResponseStream();

    await testEnv.handler(
      makeEvent({ thread_id: 'not-a-uuid', messages: VALID_MESSAGES }),
      responseStream,
      {},
    );

    const body = JSON.parse(writtenText(responseStream));
    expect(body.error).toBe('Invalid request body');
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'thread_id',
          message: 'thread_id must be a valid UUID',
        }),
      ]),
    );
  });

  it('returns 400 when parent_run_id is provided', async () => {
    process.env.AGENT_RUNTIME_ARN =
      'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/test';
    const responseStream = createResponseStream();

    await testEnv.handler(
      makeEvent({
        thread_id: VALID_THREAD_ID,
        parent_run_id: VALID_RUN_ID,
        messages: VALID_MESSAGES,
      }),
      responseStream,
      {},
    );

    const body = JSON.parse(writtenText(responseStream));
    expect(body.error).toBe('Invalid request body');
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'parent_run_id' }),
      ]),
    );
  });

  it('returns 400 when state is not empty or last message is not a user message', async () => {
    process.env.AGENT_RUNTIME_ARN =
      'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/test';
    const responseStream = createResponseStream();

    await testEnv.handler(
      makeEvent({
        thread_id: VALID_THREAD_ID,
        state: { key: 'value' },
        messages: [{ id: '1', role: 'assistant', content: 'hi' }],
      }),
      responseStream,
      {},
    );

    const body = JSON.parse(writtenText(responseStream));
    expect(body.error).toBe('Invalid request body');
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'state' }),
        expect.objectContaining({ path: 'messages' }),
      ]),
    );
  });

  it('streams SSE chunks on success and defaults run_id when omitted', async () => {
    process.env.AGENT_RUNTIME_ARN =
      'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/test';
    const responseStream = createResponseStream();
    send.mockResolvedValueOnce({
      response: asyncChunks([
        'event: message\ndata: {"delta":"Hello"}\n\n',
        'event: message\ndata: {"delta":" world"}\n\n',
      ]),
    });

    await testEnv.handler(
      makeEvent({ thread_id: VALID_THREAD_ID, messages: VALID_MESSAGES }),
      responseStream,
      {},
    );

    expect(writtenText(responseStream)).toBe(
      'event: message\ndata: {"delta":"Hello"}\n\nevent: message\ndata: {"delta":" world"}\n\n',
    );
    expect(responseStream.end).toHaveBeenCalledOnce();

    expect(InvokeAgentRuntimeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRuntimeArn:
          'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/test',
        runtimeSessionId: VALID_THREAD_ID,
        payload: expect.stringContaining(VALID_THREAD_ID),
      }),
    );
  });

  it('writes an SSE error event on runtime invocation failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.AGENT_RUNTIME_ARN =
      'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/test';
    const responseStream = createResponseStream();
    send.mockRejectedValueOnce(new Error('Invocation error'));

    await testEnv.handler(
      makeEvent({ thread_id: VALID_THREAD_ID, messages: VALID_MESSAGES }),
      responseStream,
      {},
    );

    expect(writtenText(responseStream)).toContain('event: error');
    expect(responseStream.end).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalled();
  });
});
