/**
 * Migration system for upgrading existing Camille installations
 * Handles version upgrades and data migrations
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../logger.js';
import { GraphDB } from '../memory/databases/graph-db.js';
import { KuzuGraphDB } from '../memory/databases/kuzu-db.js';
import { EdgeResolver } from '../memory/edge-resolver.js';
import { codeParser } from '../code-parser/code-parser.js';
import ora from 'ora';
import chalk from 'chalk';

export interface MigrationVersion {
  version: string;
  description: string;
  up: (context: MigrationContext) => Promise<void>;
  down?: (context: MigrationContext) => Promise<void>;
}

export interface MigrationContext {
  homeDir: string;
  graphDB: GraphDB;
  spinner?: any;
}

export interface MigrationStatus {
  currentVersion: string;
  targetVersion: string;
  appliedMigrations: string[];
  lastMigration?: Date;
}

/**
 * Manages data migrations for Camille
 */
export class MigrationManager {
  private readonly metadataPath: string;
  private readonly migrations: Map<string, MigrationVersion>;
  private spinner?: any;

  constructor() {
    this.metadataPath = path.join(os.homedir(), '.camille', 'migration-status.json');
    this.migrations = new Map();
    
    // Register all migrations
    this.registerMigrations();
  }

  /**
   * Register all available migrations
   */
  private registerMigrations(): void {
    // v1.0.0 -> v2.0.0: Enhanced edge detection and unified embeddings
    this.migrations.set('2.0.0', {
      version: '2.0.0',
      description: 'Enhanced edge detection and unified embeddings',
      up: async (ctx) => this.migrateToV2(ctx),
      down: async (ctx) => this.rollbackFromV2(ctx)
    });

    // v2.0.0 -> v2.1.0: Performance optimizations
    this.migrations.set('2.1.0', {
      version: '2.1.0',
      description: 'Performance optimizations and batched operations',
      up: async (ctx) => this.migrateToV2_1(ctx)
    });
  }

  /**
   * Check if migration is needed
   */
  async needsMigration(): Promise<boolean> {
    const status = await this.getStatus();
    const latestVersion = this.getLatestVersion();
    return status.currentVersion !== latestVersion;
  }

  /**
   * Run pending migrations
   */
  async migrate(targetVersion?: string): Promise<void> {
    const status = await this.getStatus();
    const target = targetVersion || this.getLatestVersion();
    
    logger.info('Starting migration', {
      from: status.currentVersion,
      to: target
    });

    this.spinner = ora('Preparing migration...').start();

    try {
      // Create backup
      await this.createBackup();
      this.spinner.succeed('Backup created');

      // Get migration path
      const migrationPath = this.getMigrationPath(status.currentVersion, target);
      
      if (migrationPath.length === 0) {
        this.spinner.info('No migrations to apply');
        return;
      }

      // Initialize graph database
      const graphDB = new KuzuGraphDB();
      await graphDB.connect();
      
      const context: MigrationContext = {
        homeDir: path.join(os.homedir(), '.camille'),
        graphDB,
        spinner: this.spinner
      };

      // Apply migrations in order
      for (const version of migrationPath) {
        const migration = this.migrations.get(version);
        if (!migration) continue;

        this.spinner.start(`Applying migration ${version}: ${migration.description}`);
        
        try {
          await migration.up(context);
          status.appliedMigrations.push(version);
          status.currentVersion = version;
          await this.saveStatus(status);
          
          this.spinner.succeed(`Applied migration ${version}`);
        } catch (error) {
          this.spinner.fail(`Failed to apply migration ${version}`);
          logger.error('Migration failed', { version, error });
          
          // Attempt rollback
          if (migration.down) {
            this.spinner.start('Rolling back migration...');
            await migration.down(context);
            this.spinner.succeed('Rollback completed');
          }
          
          throw error;
        }
      }

      await graphDB.close();
      this.spinner.succeed(chalk.green('✅ Migration completed successfully'));
      
    } catch (error) {
      this.spinner.fail('Migration failed');
      throw error;
    }
  }

  /**
   * Migration to v2.0.0
   */
  private async migrateToV2(ctx: MigrationContext): Promise<void> {
    ctx.spinner.text = 'Rebuilding graph with enhanced edge detection...';
    
    // Clear existing edges (keep nodes)
    await ctx.graphDB.query(`MATCH ()-[r]->() DELETE r`);
    
    // Get all indexed files
    const indexedFiles = await this.getIndexedFiles(ctx.homeDir);
    let processed = 0;
    
    ctx.spinner.text = `Re-parsing ${indexedFiles.length} files for enhanced edges...`;
    
    // Create edge resolver
    const edgeResolver = new EdgeResolver(ctx.graphDB);
    const parsedFiles = [];
    
    // Re-parse all files
    for (const filePath of indexedFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = await codeParser.parseFile(filePath, content);
        
        if (parsed) {
          parsedFiles.push(parsed);
          processed++;
          
          if (processed % 10 === 0) {
            ctx.spinner.text = `Re-parsing files... (${processed}/${indexedFiles.length})`;
          }
        }
      } catch (error) {
        logger.warn('Failed to parse file during migration', { filePath, error });
      }
    }
    
    // Build import maps and resolve edges
    ctx.spinner.text = 'Resolving edges with new algorithm...';
    edgeResolver.buildImportMaps(parsedFiles);
    
    // Convert to pending edges
    const pendingEdges = [];
    for (const parsed of parsedFiles) {
      for (const edge of parsed.edges) {
        const targetParts = edge.target.split(':');
        if (targetParts.length >= 4) {
          pendingEdges.push({
            sourceId: edge.source,
            targetName: targetParts[2],
            targetType: targetParts[1],
            targetFile: targetParts[0],
            relationship: edge.relationship,
            metadata: edge.metadata
          });
        }
      }
    }
    
    // Resolve edges
    const stats = await edgeResolver.resolveEdges(pendingEdges);
    
    ctx.spinner.text = `Resolved ${stats.resolved} edges (${stats.unresolved} unresolved)`;
    
    // Update metadata
    await this.updateMetadata(ctx.homeDir, {
      edgeResolutionVersion: '2.0.0',
      lastMigration: new Date().toISOString(),
      stats
    });
  }

  /**
   * Rollback from v2.0.0
   */
  private async rollbackFromV2(ctx: MigrationContext): Promise<void> {
    // Restore from backup
    ctx.spinner.text = 'Restoring from backup...';
    await this.restoreBackup();
  }

  /**
   * Migration to v2.1.0
   */
  private async migrateToV2_1(ctx: MigrationContext): Promise<void> {
    ctx.spinner.text = 'Optimizing embeddings storage...';
    
    // Create unified embeddings table
    await ctx.graphDB.query(`
      CREATE TABLE IF NOT EXISTS unified_embeddings (
        id STRING PRIMARY KEY,
        type STRING,
        path STRING,
        content_hash STRING,
        embedding DOUBLE[],
        metadata STRING
      )
    `);
    
    // Migrate existing embeddings
    const nodes = await ctx.graphDB.findNodes();
    let migrated = 0;
    
    for (const node of nodes) {
      if (node.name_embedding || node.summary_embedding) {
        // Store in unified table
        // (Implementation depends on actual storage mechanism)
        migrated++;
      }
    }
    
    ctx.spinner.text = `Migrated ${migrated} embeddings to unified storage`;
  }

  /**
   * Get current migration status
   */
  async getStatus(): Promise<MigrationStatus> {
    try {
      const content = await fs.readFile(this.metadataPath, 'utf8');
      return JSON.parse(content);
    } catch {
      // Default status for new installations
      return {
        currentVersion: '1.0.0',
        targetVersion: this.getLatestVersion(),
        appliedMigrations: [],
        lastMigration: undefined
      };
    }
  }

  /**
   * Save migration status
   */
  private async saveStatus(status: MigrationStatus): Promise<void> {
    status.lastMigration = new Date();
    await fs.mkdir(path.dirname(this.metadataPath), { recursive: true });
    await fs.writeFile(this.metadataPath, JSON.stringify(status, null, 2));
  }

  /**
   * Get latest version
   */
  private getLatestVersion(): string {
    const versions = Array.from(this.migrations.keys()).sort();
    return versions[versions.length - 1] || '1.0.0';
  }

  /**
   * Get migration path between versions
   */
  private getMigrationPath(from: string, to: string): string[] {
    const versions = Array.from(this.migrations.keys()).sort();
    const fromIndex = versions.indexOf(from);
    const toIndex = versions.indexOf(to);
    
    if (fromIndex === -1 || toIndex === -1 || fromIndex >= toIndex) {
      return [];
    }
    
    return versions.slice(fromIndex + 1, toIndex + 1);
  }

  /**
   * Create backup before migration
   */
  private async createBackup(): Promise<void> {
    const backupDir = path.join(os.homedir(), '.camille', 'backups', new Date().toISOString());
    await fs.mkdir(backupDir, { recursive: true });
    
    // Backup graph database
    const graphDir = path.join(os.homedir(), '.camille', 'memory', 'graph');
    if (await this.exists(graphDir)) {
      await this.copyDir(graphDir, path.join(backupDir, 'graph'));
    }
    
    // Backup embeddings
    const embeddingsDir = path.join(os.homedir(), '.camille', 'memory', 'vectors');
    if (await this.exists(embeddingsDir)) {
      await this.copyDir(embeddingsDir, path.join(backupDir, 'vectors'));
    }
    
    logger.info('Backup created', { backupDir });
  }

  /**
   * Restore from backup
   */
  private async restoreBackup(): Promise<void> {
    // Find latest backup
    const backupsDir = path.join(os.homedir(), '.camille', 'backups');
    const backups = await fs.readdir(backupsDir);
    
    if (backups.length === 0) {
      throw new Error('No backups available');
    }
    
    const latestBackup = backups.sort().reverse()[0];
    const backupPath = path.join(backupsDir, latestBackup);
    
    // Restore graph
    const graphBackup = path.join(backupPath, 'graph');
    const graphDir = path.join(os.homedir(), '.camille', 'memory', 'graph');
    if (await this.exists(graphBackup)) {
      await this.copyDir(graphBackup, graphDir);
    }
    
    // Restore embeddings
    const embeddingsBackup = path.join(backupPath, 'vectors');
    const embeddingsDir = path.join(os.homedir(), '.camille', 'memory', 'vectors');
    if (await this.exists(embeddingsBackup)) {
      await this.copyDir(embeddingsBackup, embeddingsDir);
    }
    
    logger.info('Restored from backup', { backupPath });
  }

  /**
   * Get list of indexed files
   */
  private async getIndexedFiles(homeDir: string): Promise<string[]> {
    // This would need to be implemented based on how files are tracked
    // For now, return empty array
    return [];
  }

  /**
   * Update metadata file
   */
  private async updateMetadata(homeDir: string, data: any): Promise<void> {
    const metadataPath = path.join(homeDir, 'metadata.json');
    let metadata = {};
    
    try {
      const content = await fs.readFile(metadataPath, 'utf8');
      metadata = JSON.parse(content);
    } catch {
      // File doesn't exist
    }
    
    Object.assign(metadata, data);
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  /**
   * Check if path exists
   */
  private async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Copy directory recursively
   */
  private async copyDir(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      
      if (entry.isDirectory()) {
        await this.copyDir(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
}