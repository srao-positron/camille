import { Command } from 'commander';
import { BrowserService } from '../services/browser-service.js';
import { logger } from '../logger.js';
import * as process from 'process';

export const browserCommand = new Command('browser')
  .description('Start browser automation service')
  .action(async () => {
    logger.info('Starting browser automation service...');
    
    const browserService = new BrowserService();
    
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