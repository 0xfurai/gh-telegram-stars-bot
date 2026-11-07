import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config } from '../config';

// Define log levels with priorities
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define colors for console output in development
const logColors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

// Add colors to winston
winston.addColors(logColors);

// Custom format for development (colorized and pretty)
const developmentFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize({ all: true }),
  winston.format.printf((info) => {
    const { timestamp, level, message, service, correlationId, ...meta } = info;

    let logMessage = `${timestamp} [${level}]`;

    if (service) {
      logMessage += ` [${service}]`;
    }

    if (correlationId) {
      logMessage += ` [${correlationId}]`;
    }

    logMessage += `: ${message}`;

    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      logMessage += `\n${JSON.stringify(meta, null, 2)}`;
    }

    return logMessage;
  })
);

// Custom format for production (structured JSON)
const productionFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf((info) => {
    // Ensure we have consistent structure for cloud logging
    const logEntry: Record<string, any> = {
      timestamp: info.timestamp,
      level: info.level,
      message: info.message,
      service: info.service || 'telegram-github-stars',
      environment: config.nodeEnv,
    };

    // Add optional fields conditionally
    if (info.correlationId) {
      logEntry.correlationId = info.correlationId;
    }
    if (info.chatId) {
      logEntry.chatId = info.chatId;
    }
    if (info.userId) {
      logEntry.userId = info.userId;
    }
    if (info.repository) {
      logEntry.repository = info.repository;
    }
    if (info.error && typeof info.error === 'object' && 'message' in info.error) {
      const error = info.error as Error;
      logEntry.error = {
        message: error.message,
        stack: error.stack,
        name: error.name
      };
    }

    // Include any additional metadata
    Object.keys(info).forEach(key => {
      if (!['timestamp', 'level', 'message', 'service', 'correlationId', 'chatId', 'userId', 'repository', 'error'].includes(key)) {
        logEntry[key] = info[key];
      }
    });

    return JSON.stringify(logEntry);
  })
);

// Create transports
const transports: winston.transport[] = [];

// Console transport (always present)
transports.push(
  new winston.transports.Console({
    format: config.nodeEnv === 'production' ? productionFormat : developmentFormat,
  })
);

// File transports for production
if (config.nodeEnv === 'production') {
  // Error logs
  transports.push(
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '14d',
      maxSize: '20m',
      format: productionFormat,
    })
  );

  // Combined logs
  transports.push(
    new DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      maxSize: '20m',
      format: productionFormat,
    })
  );
}

// Create the winston logger instance
const winstonLogger = winston.createLogger({
  level: config.logging.level,
  levels: logLevels,
  defaultMeta: {
    service: 'telegram-github-stars',
    environment: config.nodeEnv,
  },
  transports,
  // Don't exit on handled exceptions
  exitOnError: false,
});

// Context storage for correlation IDs
class LoggerContext {
  private static contexts = new Map<string, Record<string, any>>();

  static setContext(correlationId: string, context: Record<string, any>): void {
    this.contexts.set(correlationId, { ...this.contexts.get(correlationId), ...context });
  }

  static getContext(correlationId: string): Record<string, any> {
    return this.contexts.get(correlationId) || {};
  }

  static clearContext(correlationId: string): void {
    this.contexts.delete(correlationId);
  }

  static generateCorrelationId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Enhanced logger interface
export interface LogContext {
  correlationId?: string;
  chatId?: number;
  userId?: number;
  repository?: string;
  duration?: number;
  [key: string]: any;
}

class Logger {
  private logger: winston.Logger;

  constructor() {
    this.logger = winstonLogger;
  }

  private formatMessage(level: string, message: string, context?: LogContext): void {
    const logData: any = { message };

    if (context) {
      Object.assign(logData, context);

      // If we have a correlation ID, merge with stored context
      if (context.correlationId) {
        const storedContext = LoggerContext.getContext(context.correlationId);
        Object.assign(logData, storedContext);
      }
    }

    this.logger.log(level, logData);
  }

  info(message: string, context?: LogContext): void {
    this.formatMessage('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.formatMessage('warn', message, context);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    const errorContext = { ...context };
    if (error) {
      errorContext.error = error;
    }
    this.formatMessage('error', message, errorContext);
  }

  debug(message: string, context?: LogContext): void {
    this.formatMessage('debug', message, context);
  }

  http(message: string, context?: LogContext): void {
    this.formatMessage('http', message, context);
  }

  // Utility methods for common use cases
  startOperation(operationName: string, context?: LogContext): string {
    const correlationId = LoggerContext.generateCorrelationId();
    const operationContext = {
      ...context,
      correlationId,
      operation: operationName,
      startTime: Date.now(),
    };

    LoggerContext.setContext(correlationId, operationContext);
    this.info(`Starting ${operationName}`, { correlationId, ...context });

    return correlationId;
  }

  endOperation(correlationId: string, success: boolean = true, additionalContext?: LogContext): void {
    const context = LoggerContext.getContext(correlationId);
    const duration = Date.now() - (context.startTime || Date.now());

    const endContext = {
      ...additionalContext,
      correlationId,
      duration,
      success,
    };

    if (success) {
      this.info(`Completed ${context.operation || 'operation'}`, endContext);
    } else {
      this.warn(`Failed ${context.operation || 'operation'}`, endContext);
    }

    LoggerContext.clearContext(correlationId);
  }

  // Bot-specific logging methods
  botMessage(message: string, chatId: number, userId?: number, context?: LogContext): void {
    this.info(message, {
      ...context,
      chatId,
      userId,
      component: 'bot',
    });
  }

  githubOperation(message: string, repository: string, context?: LogContext): void {
    this.info(message, {
      ...context,
      repository,
      component: 'github',
    });
  }

  databaseOperation(message: string, operation: string, context?: LogContext): void {
    this.info(message, {
      ...context,
      operation,
      component: 'database',
    });
  }

  webhookOperation(message: string, context?: LogContext): void {
    this.info(message, {
      ...context,
      component: 'webhook',
    });
  }

  pollingOperation(message: string, context?: LogContext): void {
    this.info(message, {
      ...context,
      component: 'polling',
    });
  }
}

// Export a singleton instance
export const logger = new Logger();

// Export context utilities
export { LoggerContext };
