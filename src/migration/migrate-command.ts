/**
 * CLI command for running migrations
 */

import { Command } from 'commander';
import { MigrationManager } from './migration-manager.js';
import { consoleOutput } from '../utils/console.js';
import chalk from 'chalk';
import { logger } from '../logger.js';

export function createMigrateCommand(): Command {
  const command = new Command('migrate');
  
  command
    .description('Run data migrations to upgrade Camille')
    .option('--check', 'Check if migrations are needed without running them')
    .option('--target <version>', 'Migrate to specific version')
    .option('--rollback', 'Rollback last migration')
    .option('--status', 'Show current migration status')
    .action(async (options) => {
      const manager = new MigrationManager();
      
      try {
        if (options.status) {
          // Show migration status
          const status = await manager.getStatus();
          consoleOutput.info(chalk.blue('Migration Status'));
          consoleOutput.info('═══════════════════════════════════');
          consoleOutput.info(`Current Version: ${chalk.yellow(status.currentVersion)}`);
          consoleOutput.info(`Latest Version: ${chalk.green(status.targetVersion)}`);
          consoleOutput.info(`Applied Migrations: ${status.appliedMigrations.length}`);
          
          if (status.lastMigration) {
            consoleOutput.info(`Last Migration: ${new Date(status.lastMigration).toLocaleString()}`);
          }
          
          if (status.appliedMigrations.length > 0) {
            consoleOutput.info('\nApplied Migrations:');
            for (const version of status.appliedMigrations) {
              consoleOutput.info(`  • ${version}`);
            }
          }
          
          return;
        }
        
        if (options.check) {
          // Check if migration is needed
          const needed = await manager.needsMigration();
          
          if (needed) {
            consoleOutput.info(chalk.yellow('⚠️  Migration required'));
            consoleOutput.info('Run "camille migrate" to upgrade your installation');
          } else {
            consoleOutput.info(chalk.green('✅ No migrations needed'));
          }
          
          return;
        }
        
        if (options.rollback) {
          // Rollback functionality (not fully implemented yet)
          consoleOutput.error('Rollback functionality not yet implemented');
          return;
        }
        
        // Check if migration is needed
        const needed = await manager.needsMigration();
        
        if (!needed && !options.target) {
          consoleOutput.info(chalk.green('✅ Already up to date'));
          return;
        }
        
        // Show migration plan
        consoleOutput.info(chalk.blue('\n🔄 Camille Migration Plan'));
        consoleOutput.info('═══════════════════════════════════\n');
        
        const status = await manager.getStatus();
        consoleOutput.info(`From version: ${chalk.yellow(status.currentVersion)}`);
        consoleOutput.info(`To version: ${chalk.green(options.target || status.targetVersion)}\n`);
        
        consoleOutput.info(chalk.yellow('⚠️  Important:'));
        consoleOutput.info('• A backup will be created automatically');
        consoleOutput.info('• The migration may take several minutes');
        consoleOutput.info('• Do not interrupt the process\n');
        
        // Confirm migration
        const confirm = await confirmMigration();
        if (!confirm) {
          consoleOutput.info('Migration cancelled');
          return;
        }
        
        // Run migration
        await manager.migrate(options.target);
        
        consoleOutput.info(chalk.green('\n✅ Migration completed successfully!'));
        consoleOutput.info('Please restart the Camille server to use the new features.');
        
      } catch (error) {
        consoleOutput.error(chalk.red('\n❌ Migration failed'));
        logger.error('Migration failed', { error });
        
        if (error instanceof Error) {
          consoleOutput.error(error.message);
        }
        
        consoleOutput.info('\nYour data has been backed up and can be restored if needed.');
        process.exit(1);
      }
    });
  
  return command;
}

/**
 * Prompt user to confirm migration
 */
async function confirmMigration(): Promise<boolean> {
  // In a real implementation, this would use inquirer or similar
  // For now, we'll auto-confirm
  consoleOutput.info('Starting migration...\n');
  return true;
}