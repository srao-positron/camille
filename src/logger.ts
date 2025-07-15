/**
 * Logger module for Camille
 * Provides detailed logging to ~/.camille/logs/camille.log
 */

import winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Logger class with Winston integration
 */
export class Logger {
  private logger: winston.Logger;
  private static instance: Logger;

  constructor() {
    // Ensure log directory exists
    const logDir = path.join(os.homedir(), '.camille', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, 'camille.log');
    const errorLogFile = path.join(logDir, 'camille.error.log');

    // Create logger instance
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'debug',
      format: winston.format.combine(
        winston.format.timestamp({
          format: 'YYYY-MM-DD HH:mm:ss.SSS'
        }),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { 
        service: 'camille',
        pid: process.pid,
        version: this.getVersion()
      },
      transports: [
        // Write all logs to combined log
        new winston.transports.File({ 
          filename: logFile,
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 5,
          tailable: true
        }),
        // Write errors to separate file
        new winston.transports.File({ 
          filename: errorLogFile,
          level: 'error',
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 3
        })
      ]
    });

    // Add console transport in development
    if (process.env.NODE_ENV !== 'production') {
      this.logger.add(new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        )
      }));
    }

    // Log startup
    this.logger.info('Camille logger initialized', {
      logFile,
      logLevel: this.logger.level,
      transports: this.logger.transports.map(t => t.constructor.name)
    });
  }

  /**
   * Gets singleton instance
   */
  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Gets version from package.json
   */
  private getVersion(): string {
    try {
      const pkgPath = path.join(__dirname, '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return pkg.version;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Logs info message
   */
  info(message: string, meta?: any): void {
    this.logger.info(message, meta);
  }

  /**
   * Logs warning message
   */
  warn(message: string, meta?: any): void {
    this.logger.warn(message, meta);
  }

  /**
   * Logs error message
   */
  error(message: string, error?: any, meta?: any): void {
    this.logger.error(message, {
      ...meta,
      error: error instanceof Error ? {
        message: error.message,
        stack: error.stack,
        name: error.name
      } : error
    });
  }

  /**
   * Logs debug message
   */
  debug(message: string, meta?: any): void {
    this.logger.debug(message, meta);
  }

  /**
   * Logs HTTP request
   */
  logRequest(method: string, url: string, statusCode?: number, duration?: number): void {
    this.logger.info('HTTP Request', {
      method,
      url,
      statusCode,
      duration,
      type: 'http_request'
    });
  }

  /**
   * Logs OpenAI API call
   */
  logOpenAICall(model: string, tokens: number, duration: number, success: boolean): void {
    this.logger.info('OpenAI API Call', {
      model,
      tokens,
      duration,
      success,
      type: 'openai_call'
    });
  }

  /**
   * Logs file operation
   */
  logFileOperation(operation: string, filePath: string, success: boolean): void {
    this.logger.info('File Operation', {
      operation,
      filePath,
      success,
      type: 'file_operation'
    });
  }

  /**
   * Logs hook execution
   */
  logHookExecution(tool: string, decision: string, duration: number): void {
    this.logger.info('Hook Execution', {
      tool,
      decision,
      duration,
      type: 'hook_execution'
    });
  }

  /**
   * Logs server event
   */
  logServerEvent(event: string, details?: any): void {
    this.logger.info('Server Event', {
      event,
      ...details,
      type: 'server_event'
    });
  }

  /**
   * Creates child logger with additional context
   */
  child(meta: any): Logger {
    const childLogger = new Logger();
    childLogger.logger = this.logger.child(meta);
    return childLogger;
  }
}

/**
 * Global logger instance
 */
export const logger = Logger.getInstance();