import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { getCorrelationId } from '../storage';

const addCorrelationId = winston.format((info) => {
  info['correlationId'] = getCorrelationId();
  return info;
});

const LOG_LEVELS = ['error', 'warn', 'info', 'verbose', 'debug'] as const;

export function createWinstonLogger(serviceName: string) {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const requestedLevel = process.env['LOG_LEVEL'];
  const level = LOG_LEVELS.find((l) => l === requestedLevel) ?? 'info';

  return WinstonModule.createLogger({
    level,
    transports: [
      new winston.transports.Console({
        format: isProduction
          ? winston.format.combine(
              addCorrelationId(),
              winston.format.timestamp(),
              winston.format.json(),
            )
          : winston.format.combine(
              addCorrelationId(),
              winston.format.colorize(),
              winston.format.timestamp(),
              winston.format.printf(
                ({
                  timestamp,
                  level,
                  context,
                  message,
                  correlationId,
                  ...meta
                }) => {
                  const line =
                    message !== undefined ? message : JSON.stringify(meta);
                  return `${timestamp} [${serviceName}] [${correlationId}] ${level} [${context || 'App'}]: ${line}`;
                },
              ),
            ),
      }),
    ],
  });
}
