/**
 * Git Commit Watcher
 * Monitors local git repositories for new commits and triggers design document generation
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../logger.js';
import { ConfigManager } from '../config.js';
import fetch from 'node-fetch';

const execAsync = promisify(exec);

interface GitCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
  branch: string;
  diff?: string;
}

interface RepositoryState {
  path: string;
  lastProcessedCommit: string;
  lastChecked: string;
  branch: string;
}

interface GitState {
  repositories: Record<string, RepositoryState>;
  version: string;
}

export class GitCommitWatcher {
  private configManager: ConfigManager;
  private statePath: string;
  private state: GitState;
  private checkInterval: number = 30000; // 30 seconds default
  private intervalHandle: NodeJS.Timeout | null = null;
  private watchedRepos: Set<string> = new Set();

  constructor() {
    this.configManager = new ConfigManager();
    const configDir = process.env.CAMILLE_CONFIG_DIR || path.join(process.env.HOME || '', '.camille');
    this.statePath = path.join(configDir, 'git-state.json');
    this.state = {
      repositories: {},
      version: '1.0.0'
    };
  }

  /**
   * Initialize the git watcher
   */
  async initialize(): Promise<void> {
    await this.loadState();
    logger.info('Git commit watcher initialized', { 
      watchedRepos: Object.keys(this.state.repositories).length 
    });
  }

  /**
   * Start watching repositories for new commits
   */
  async start(): Promise<void> {
    if (this.intervalHandle) {
      logger.warn('Git watcher already running');
      return;
    }

    // Initial check
    await this.checkAllRepositories();

    // Set up periodic checking
    this.intervalHandle = setInterval(async () => {
      await this.checkAllRepositories();
    }, this.checkInterval);

    logger.info('Git commit watcher started', { 
      checkInterval: this.checkInterval,
      repositories: this.watchedRepos.size 
    });
  }

  /**
   * Stop watching repositories
   */
  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      await this.saveState();
      logger.info('Git commit watcher stopped');
    }
  }

  /**
   * Add a directory to watch for git commits
   */
  async addRepository(repoPath: string): Promise<void> {
    try {
      const normalizedPath = path.resolve(repoPath);
      
      // Check if it's a git repository
      const isGitRepo = await this.isGitRepository(normalizedPath);
      if (!isGitRepo) {
        logger.debug('Not a git repository, skipping', { path: normalizedPath });
        return;
      }

      // Get current branch and HEAD commit
      const branch = await this.getCurrentBranch(normalizedPath);
      const headCommit = await this.getHeadCommit(normalizedPath);

      if (!headCommit) {
        logger.warn('Could not get HEAD commit', { path: normalizedPath });
        return;
      }

      // Add or update repository state
      this.state.repositories[normalizedPath] = {
        path: normalizedPath,
        lastProcessedCommit: this.state.repositories[normalizedPath]?.lastProcessedCommit || headCommit,
        lastChecked: new Date().toISOString(),
        branch
      };

      this.watchedRepos.add(normalizedPath);
      await this.saveState();

      logger.info('Added git repository to watch', { 
        path: normalizedPath, 
        branch, 
        headCommit 
      });
    } catch (error) {
      logger.error('Failed to add repository', { path: repoPath, error });
    }
  }

  /**
   * Remove a repository from watching
   */
  async removeRepository(repoPath: string): Promise<void> {
    const normalizedPath = path.resolve(repoPath);
    delete this.state.repositories[normalizedPath];
    this.watchedRepos.delete(normalizedPath);
    await this.saveState();
    logger.info('Removed repository from watch', { path: normalizedPath });
  }

  /**
   * Check all watched repositories for new commits
   */
  private async checkAllRepositories(): Promise<void> {
    const repos = Array.from(this.watchedRepos);
    
    for (const repoPath of repos) {
      try {
        await this.checkRepository(repoPath);
      } catch (error) {
        logger.error('Failed to check repository', { path: repoPath, error });
      }
    }
  }

  /**
   * Check a single repository for new commits
   */
  private async checkRepository(repoPath: string): Promise<void> {
    const repoState = this.state.repositories[repoPath];
    if (!repoState) {
      logger.warn('Repository not in state', { path: repoPath });
      return;
    }

    // Check if branch has changed
    const currentBranch = await this.getCurrentBranch(repoPath);
    if (currentBranch !== repoState.branch) {
      logger.info('Branch changed', { 
        path: repoPath, 
        from: repoState.branch, 
        to: currentBranch 
      });
      repoState.branch = currentBranch;
      // Reset last processed commit when branch changes
      repoState.lastProcessedCommit = await this.getHeadCommit(repoPath) || repoState.lastProcessedCommit;
      await this.saveState();
      return;
    }

    // Get new commits since last processed
    const newCommits = await this.getNewCommits(repoPath, repoState.lastProcessedCommit);
    
    if (newCommits.length === 0) {
      logger.debug('No new commits', { path: repoPath });
      return;
    }

    logger.info('Found new commits', { 
      path: repoPath, 
      count: newCommits.length,
      commits: newCommits.map(c => c.hash.substring(0, 7))
    });

    // Process each new commit
    for (const commit of newCommits) {
      try {
        await this.processCommit(repoPath, commit);
        
        // Update last processed commit
        repoState.lastProcessedCommit = commit.hash;
        repoState.lastChecked = new Date().toISOString();
        await this.saveState();
      } catch (error) {
        logger.error('Failed to process commit', { 
          path: repoPath, 
          commit: commit.hash, 
          error 
        });
        // Don't update lastProcessedCommit if processing failed
        break;
      }
    }
  }

  /**
   * Process a single commit and generate design document
   */
  private async processCommit(repoPath: string, commit: GitCommit): Promise<void> {
    logger.info('Processing commit', { 
      path: repoPath, 
      hash: commit.hash.substring(0, 7),
      message: commit.message.substring(0, 50)
    });

    // Get commit diff
    const diff = await this.getCommitDiff(repoPath, commit.hash);
    commit.diff = diff;

    // Get commit stats
    const stats = await this.getCommitStats(repoPath, commit.hash);

    // Prepare payload for design document generation
    // API expects fields at root level, not nested
    const payload = {
      hash: commit.hash,
      branch: commit.branch,
      message: commit.message,
      diff: diff,
      stats: stats,
      timestamp: new Date().toISOString(),
      projectPath: repoPath
    };

    // Send to design document API
    await this.generateDesignDocument(payload);
  }

  /**
   * Generate a design document for a git commit
   */
  private async generateDesignDocument(payload: any): Promise<void> {
    try {
      const config = this.configManager.getConfig();
      
      // Check if Supastate is configured
      if (!config.supastate?.enabled) {
        logger.debug('Supastate not configured, skipping design document generation');
        return;
      }

      // Use local development URL for now
      const portalUrl = 'http://localhost:3000';
      const url = `${portalUrl}/api/generate-design-document`;

      // Prepare headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Document-Type': 'commit'
      };

      // Add authentication
      if (config.supastate.apiKey) {
        const userId = config.supastate.userId || 'anonymous';
        const workspaceId = config.supastate.teamId ? `team:${config.supastate.teamId}` : `user:${userId}`;
        headers['X-Supastate-Auth'] = JSON.stringify({
          userId: userId,
          workspaceId: workspaceId
        });
        headers['X-API-Key'] = config.supastate.apiKey;
      } else if (config.supastate.accessToken) {
        headers['Authorization'] = `Bearer ${config.supastate.accessToken}`;
      }

      logger.info('Generating design document for commit', { 
        url,
        commitHash: payload.hash.substring(0, 7)
      });

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Failed to generate design document', { 
          status: response.status, 
          error: errorText 
        });
        return;
      }

      const result = await response.json() as any;
      logger.info('Design document generation started', { 
        documentId: result.documentId,
        status: result.status 
      });

    } catch (error) {
      logger.error('Design document generation failed', { error });
    }
  }

  /**
   * Check if a directory is a git repository
   */
  private async isGitRepository(dirPath: string): Promise<boolean> {
    try {
      await execAsync('git rev-parse --git-dir', { cwd: dirPath });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the current branch name
   */
  private async getCurrentBranch(repoPath: string): Promise<string> {
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
      return stdout.trim();
    } catch (error) {
      logger.error('Failed to get current branch', { path: repoPath, error });
      return 'unknown';
    }
  }

  /**
   * Get the HEAD commit hash
   */
  private async getHeadCommit(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: repoPath });
      return stdout.trim();
    } catch (error) {
      logger.error('Failed to get HEAD commit', { path: repoPath, error });
      return null;
    }
  }

  /**
   * Get new commits since a given commit
   */
  private async getNewCommits(repoPath: string, sinceCommit: string): Promise<GitCommit[]> {
    try {
      // Get commits from sinceCommit (exclusive) to HEAD (inclusive)
      const { stdout } = await execAsync(
        `git log ${sinceCommit}..HEAD --pretty=format:"%H|%an|%ad|%s" --date=iso`,
        { cwd: repoPath }
      );

      if (!stdout.trim()) {
        return [];
      }

      const branch = await this.getCurrentBranch(repoPath);
      const commits = stdout.trim().split('\n').map(line => {
        const [hash, author, date, ...messageParts] = line.split('|');
        return {
          hash,
          author,
          date,
          message: messageParts.join('|'),
          branch
        };
      });

      // Return in chronological order (oldest first)
      return commits.reverse();
    } catch (error) {
      logger.error('Failed to get new commits', { path: repoPath, error });
      return [];
    }
  }

  /**
   * Get the diff for a specific commit
   */
  private async getCommitDiff(repoPath: string, commitHash: string): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `git show --no-color --pretty=format:"" ${commitHash}`,
        { cwd: repoPath, maxBuffer: 1024 * 1024 * 10 } // 10MB buffer
      );
      return stdout;
    } catch (error) {
      logger.error('Failed to get commit diff', { path: repoPath, commit: commitHash, error });
      return '';
    }
  }

  /**
   * Get commit statistics (files changed, insertions, deletions)
   */
  private async getCommitStats(repoPath: string, commitHash: string): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `git show --stat --pretty=format:"" ${commitHash}`,
        { cwd: repoPath }
      );
      return stdout.trim();
    } catch (error) {
      logger.error('Failed to get commit stats', { path: repoPath, commit: commitHash, error });
      return '';
    }
  }

  /**
   * Load state from disk
   */
  private async loadState(): Promise<void> {
    try {
      const data = await fs.readFile(this.statePath, 'utf8');
      this.state = JSON.parse(data);
      
      // Rebuild watchedRepos set
      this.watchedRepos.clear();
      for (const repoPath of Object.keys(this.state.repositories)) {
        this.watchedRepos.add(repoPath);
      }
      
      logger.debug('Loaded git watcher state', { 
        repositories: this.watchedRepos.size 
      });
    } catch (error) {
      // File doesn't exist yet, that's ok
      if ((error as any).code !== 'ENOENT') {
        logger.error('Failed to load git watcher state', { error });
      }
    }
  }

  /**
   * Save state to disk
   */
  private async saveState(): Promise<void> {
    try {
      const dir = path.dirname(this.statePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2));
      logger.debug('Saved git watcher state');
    } catch (error) {
      logger.error('Failed to save git watcher state', { error });
    }
  }

  /**
   * Set the check interval
   */
  setCheckInterval(intervalMs: number): void {
    this.checkInterval = intervalMs;
    
    // Restart if already running
    if (this.intervalHandle) {
      this.stop().then(() => this.start());
    }
  }

  /**
   * Get current state (for debugging)
   */
  getState(): GitState {
    return this.state;
  }
}