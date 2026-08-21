import { Readable } from 'node:stream';
import middy from '@middy/core';
import { executionModeStreamifyResponse } from '@middy/core/StreamifyResponse';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import httpJsonBodyParser from '@middy/http-json-body-parser';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  RunAgentInputSchema,
  ClientInputHeadersSchema,
} from '../../schemas/client-input.ts';
import {
  zodBodyValidator,
  zodHeadersValidator,
} from '../../http/zod-validator.ts';
import {
  buildJsonErrorResponse,
  type JsonErrorResponse,
} from '../../http/errors.ts';
import { relayAgentEventStream } from '../../streaming/agent-event-stream.ts';

const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN;
if (!agentRuntimeArn) {
  throw new Error('AGENT_RUNTIME_ARN is not configured');
}

const client = new BedrockAgentCoreClient({});

interface AgentEventStreamResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Readable;
}

export const handler = middy({
  executionMode: executionModeStreamifyResponse,
})
  .use(httpHeaderNormalizer())
  .use(zodHeadersValidator(ClientInputHeadersSchema))
  .use(httpJsonBodyParser())
  .use(zodBodyValidator(RunAgentInputSchema))
  // Registered after the middleware so the event type it receives is the one
  // the chain produces - a parsed, validated body and headers. Registering it
  // first would make that an assumption rather than something the compiler
  // checks.
  .handler(
    async (event): Promise<AgentEventStreamResponse | JsonErrorResponse> => {
      const endUserId = event.headers['end-user-id'];
      const body = event.body;

      const payload = {
        threadId: body.threadId,
        runId: body.runId,
        state: body.state ?? {},
        messages: body.messages ?? [],
        tools: body.tools ?? [],
        context: body.context ?? [],
        forwardedProps: { endUserId },
      };

      let response;
      try {
        const command = new InvokeAgentRuntimeCommand({
          agentRuntimeArn,
          runtimeSessionId: body.threadId,
          contentType: 'application/json',
          accept: 'text/event-stream',
          qualifier: 'DEFAULT',
          payload: JSON.stringify(payload),
        });

        response = await client.send(command);
      } catch {
        // TODO: Log error here.
        return buildJsonErrorResponse(500, { error: 'Agent invocation error' });
      }

      // The SDK types 'response.response' as optional, so we guard against
      // it being absent even though the runtime should always return a body.
      if (!response.response) {
        // TODO: Log error here.
        return buildJsonErrorResponse(500, { error: 'Agent invocation error' });
      }

      const sseStream = Readable.from(
        relayAgentEventStream({
          source: response.response as AsyncIterable<Uint8Array>,
          threadId: body.threadId,
          runId: body.runId,
        }),
      );

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        body: sseStream,
      };
    },
  );
