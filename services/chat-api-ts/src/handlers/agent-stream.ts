import type { Writable } from 'node:stream';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { z } from 'zod';

const client = new BedrockAgentCoreClient({});

const MessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().min(1, 'content must not be empty'),
});

const RunAgentInputSchema = z.object({
  thread_id: z.uuid({ message: 'thread_id must be a valid UUID' }),
  run_id: z.uuid({ message: 'run_id must be a valid UUID' }).optional(),
  parent_run_id: z.never().optional(),
  state: z.object({}).strict().optional(),
  forwarded_props: z.object({}).strict().optional(),
  messages: z
    .array(MessageSchema)
    .min(1, 'messages must contain at least one message')
    .refine((messages) => messages.at(-1)?.role === 'user', {
      message: 'the last message must be a user message',
    }),
  tools: z.tuple([]).optional(),
  context: z.tuple([]).optional(),
});
export const handler = awslambda.streamifyResponse(
  async (event: APIGatewayProxyEvent, responseStream: Writable) => {
    const failEarly = (statusCode: number, body: Record<string, unknown>) => {
      const stream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
      });
      stream.write(JSON.stringify(body));
      stream.end();
    };

    const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN;
    if (!agentRuntimeArn) {
      return failEarly(500, { error: 'AGENT_RUNTIME_ARN is not configured' });
    }

    const endUserId = event.headers?.['end-user-id'];
    if (!endUserId) {
      return failEarly(400, {
        error: 'Invalid request headers',
        details: [
          { path: 'end-user-id', message: 'end-user-id header is required' },
        ],
      });
    }

    let rawBody: unknown;
    try {
      rawBody = event.body ? JSON.parse(event.body) : {};
    } catch {
      return failEarly(400, { error: 'Invalid JSON in request body' });
    }

    const parseResult = RunAgentInputSchema.safeParse(rawBody);
    if (!parseResult.success) {
      const details = parseResult.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      return failEarly(400, { error: 'Invalid request body', details });
    }

    const body = parseResult.data;
    const runId = body.run_id ?? crypto.randomUUID();

    const payload = {
      thread_id: body.thread_id,
      run_id: runId,
      state: body.state ?? {},
      messages: body.messages ?? [],
      tools: body.tools ?? [],
      context: body.context ?? [],
      forwarded_props: body.forwarded_props ?? {},
      end_user_id: endUserId,
    };

    const sseStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });

    try {
      const command = new InvokeAgentRuntimeCommand({
        agentRuntimeArn,
        runtimeSessionId: body.thread_id,
        contentType: 'application/json',
        accept: 'text/event-stream',
        qualifier: 'DEFAULT',
        payload: JSON.stringify(payload),
      });

      const response = await client.send(command);

      if (!response.response) {
        throw new Error('No response body from agent runtime');
      }

      for await (const chunk of response.response as AsyncIterable<Uint8Array>) {
        sseStream.write(chunk);
      }
    } catch (error) {
      console.error('AgentCore invocation failed:', error);
      sseStream.write(
        'event: error\ndata: {"message":"Failed to invoke agent runtime"}\n\n',
      );
    } finally {
      sseStream.end();
    }
  },
);
