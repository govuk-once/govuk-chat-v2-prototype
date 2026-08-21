import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'chat-api-ts' });

export type LogContext = Record<string, unknown>;

export function reportError(message: string, context: LogContext = {}): void {
  logger.error(message, context);
  // TODO: Once Sentry is added to this service, also forward here via
  // Sentry.captureException(context.error, { extra: { message, ...context } }).
}

export function reportWarning(message: string, context: LogContext = {}): void {
  logger.warn(message, context);
}
