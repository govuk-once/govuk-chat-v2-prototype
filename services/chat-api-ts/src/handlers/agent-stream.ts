import { Readable } from 'node:stream';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';

// The Node.js Lambda runtime injects this global when the function
// is invoked via InvokeWithResponseStream. No npm package for it yet.
declare const awslambda: {
  streamifyResponse: (
    handler: (
      event: APIGatewayProxyEvent,
      responseStream: NodeJS.WritableStream,
      context: unknown,
    ) => Promise<void>,
  ) => unknown;
  HttpResponseStream: {
    from: (
      responseStream: NodeJS.WritableStream,
      metadata: { statusCode: number; headers?: Record<string, string> },
    ) => NodeJS.WritableStream;
  };
};

interface RequestBody {
  message: string;
  session_id: string;
  end_user_id: string;
}

const client = new BedrockAgentCoreClient({});

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const agentArn = process.env.AGENT_RUNTIME_ARN;

  const failEarly = (statusCode: number, error: string) => {
    const stream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers: { 'Content-Type': 'application/json' },
    });
    stream.write(JSON.stringify({ error }));
    stream.end();
  };

  if (!agentArn) {
    return failEarly(500, 'AGENT_RUNTIME_ARN is not configured');
  }

  let parsedBody: Partial<RequestBody>;
  try {
    parsedBody = event.body ? JSON.parse(event.body) : {};
  } catch {
    return failEarly(400, 'Invalid JSON in request body');
  }

  const { message, session_id, end_user_id } = parsedBody;
  const missingFields: string[] = [];
  if (typeof message !== 'string' || message.trim() === '') missingFields.push('message');
  if (typeof session_id !== 'string' || session_id.length < 33) {
    missingFields.push('session_id (string, min 33 chars)');
  }
  if (typeof end_user_id !== 'string' || end_user_id.trim() === '') missingFields.push('end_user_id');

  if (missingFields.length > 0) {
    return failEarly(400, `Missing or invalid required field(s): ${missingFields.join(', ')}`);
  }

  // From here on, headers are committed, so errors must be sent as SSE events,
  // not JSON error bodies.
  const httpStream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });

  try {
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: agentArn,
      runtimeSessionId: session_id,
      contentType: 'application/json',
      accept: 'text/event-stream',
      qualifier: 'DEFAULT',
      payload: JSON.stringify({ prompt: message, end_user_id }),
    });

    const response = await client.send(command);

    if (!response.response) {
      throw new Error('No response body from agent runtime');
    }

    // response.response is an async-iterable byte stream (SDK v3 stream mixin).
    // The agent's payload is already SSE-formatted text, so we forward chunks as-is.
    for await (const chunk of response.response as Readable) {
      httpStream.write(chunk);
    }
  } catch (err) {
    console.error('AgentCore invocation failed:', err);
    httpStream.write(
      `event: error\ndata: ${JSON.stringify({ error: 'Failed to invoke agent runtime' })}\n\n`,
    );
  } finally {
    httpStream.end();
  }
});
