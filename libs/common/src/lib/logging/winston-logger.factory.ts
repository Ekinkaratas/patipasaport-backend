import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';

export function createWinstonLogger(serviceName: string) {
  const isProduction = process.env['NODE_ENV'] === 'production';

  return WinstonModule.createLogger({
    transports: [
      new winston.transports.Console({
        format: isProduction
          ? winston.format.combine(
              winston.format.timestamp(),
              winston.format.json(),
            )
          : winston.format.combine(
              winston.format.colorize(),
              winston.format.timestamp(),
              winston.format.printf(
                ({ timestamp, level, context, message, ...meta }) => {
                  const line =
                    message !== undefined ? message : JSON.stringify(meta);
                  return `${timestamp} [${serviceName}] ${level} [${context}]: ${line}`;
                },
              ),
            ),
      }),
    ],
  });
}
