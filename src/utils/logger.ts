import pino from 'pino';

export function createLogger(name: string): pino.Logger {
  return pino({
    name,
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport:
      process.env['NODE_ENV'] === 'development'
        ? { target: 'pino/file', options: { destination: 1 } }
        : undefined,
  });
}
