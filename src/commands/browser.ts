import { Command } from 'commander';
import { BrowserService } from '../services/browser-service.js';
import { logger } from '../logger.js';
import * as process from 'process';

export const browserCommand = new Command('browser')
  .description('Start browser automation service')
  .option('--browser <type>', 'Browser type to use (chromium or firefox)', 'chromium')
  .action(async (options) => {
    // Validate browser type
    const browserType = options.browser?.toLowerCase();
    if (browserType !== 'chromium' && browserType !== 'firefox') {
      logger.error(`Invalid browser type: ${browserType}. Must be 'chromium' or 'firefox'.`);
      process.exit(1);
    }
    
    logger.info(`Starting browser automation service with ${browserType}...`);
    
    const browserService = new BrowserService(browserType as 'chromium' | 'firefox');
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await browserService.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await browserService.stop();
      process.exit(0);
    });
    
    try {
      await browserService.start();
      logger.info('Browser automation service is running. Press Ctrl+C to stop.');
      
      // Keep the process alive
      await new Promise(() => {});
    } catch (error) {
      logger.error('Failed to start browser service:', error);
      process.exit(1);
    }
  });