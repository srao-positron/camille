/**
 * Console output utilities
 * Provides conditional console output based on quiet mode
 */

import chalk from 'chalk';
import { logger } from '../logger';

/**
 * Checks if running in quiet mode
 */
export function isQuietMode(): boolean {
  return process.env.CAMILLE_QUIET === 'true';
}

/**
 * Conditionally outputs to console or logger
 */
export function output(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  // Always log to file
  switch (level) {
    case 'warn':
      logger.warn(stripAnsi(message));
      break;
    case 'error':
      logger.error(stripAnsi(message));
      break;
    default:
      logger.info(stripAnsi(message));
  }
  
  // Also output to console unless in quiet mode
  if (!isQuietMode()) {
    switch (level) {
      case 'warn':
        console.warn(message);
        break;
      case 'error':
        console.error(message);
        break;
      default:
        console.log(message);
    }
  }
}

/**
 * Strip ANSI color codes for logging
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[\d+m/g, '');
}

/**
 * Console output helpers
 */
export const consoleOutput = {
  info: (message: string) => output(message, 'info'),
  success: (message: string) => output(chalk.green(message), 'info'),
  warning: (message: string) => output(chalk.yellow(message), 'warn'),
  error: (message: string) => output(chalk.red(message), 'error'),
  debug: (message: string) => {
    if (!isQuietMode() && process.env.DEBUG !== undefined) {
      output(chalk.gray(message), 'info');
    }
    logger.debug(stripAnsi(message));
  }
};