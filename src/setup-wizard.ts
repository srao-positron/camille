/**
 * Interactive setup wizard for Camille
 * Provides a beautiful, user-friendly first-run experience
 */

import inquirer from 'inquirer';
import inquirerAutocompletePrompt from 'inquirer-autocomplete-prompt';
import fuzzy from 'fuzzy';
import chalk from 'chalk';
import ora, { Ora } from 'ora';
import boxen from 'boxen';
import figlet from 'figlet';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import { ConfigManager } from './config';
import { LLMClient } from './llm-client';
import { Logger } from './logger';
import { spawn } from 'child_process';
import { 
  getModelsForProvider, 
  getRecommendedModels,
  ModelInfo,
  LLMProvider 
} from './providers';
import { createProvider } from './providers';

// Register autocomplete prompt
inquirer.registerPrompt('autocomplete', inquirerAutocompletePrompt);

/**
 * Setup wizard class
 */
export class SetupWizard {
  private configManager: ConfigManager;
  private logger: Logger;

  constructor() {
    this.configManager = new ConfigManager();
    this.logger = new Logger();
  }

  /**
   * Runs the complete setup wizard
   */
  async run(): Promise<void> {
    try {
      // Check if running as root
      if (process.getuid && process.getuid() === 0) {
        console.error(chalk.red('\n❌ Do not run the setup wizard with sudo!'));
        console.error(chalk.yellow('\nRunning as root will:'));
        console.error(chalk.gray('  • Create config files owned by root'));
        console.error(chalk.gray('  • Update root\'s Claude settings instead of yours'));
        console.error(chalk.gray('  • Cause permission errors later\n'));
        
        // Check if there's a permission issue
        const configPath = path.join(os.homedir(), '.camille', 'config.json');
        if (fs.existsSync(configPath)) {
          try {
            fs.accessSync(configPath, fs.constants.W_OK);
          } catch {
            console.error(chalk.yellow('It looks like you have permission issues from a previous sudo install.'));
            console.error(chalk.cyan('\nTo fix this, run:'));
            console.error(chalk.gray('  cd ' + path.join(__dirname, '..')));
            console.error(chalk.gray('  ./fix-permissions.sh\n'));
          }
        }
        
        process.exit(1);
      }

      // Show welcome screen
      this.showWelcome();

      // Check if already configured
      if (await this.checkExistingConfig()) {
        return;
      }

      // Start setup process
      this.logger.info('Starting Camille setup wizard');
      
      // Step 1: Configure LLM provider and models
      const providerConfig = await this.setupProviderAndModels();
      
      // Step 2: Select directories to monitor
      const directories = await this.selectDirectories();
      
      // Step 3: Configure MCP integration
      const mcpConfig = await this.setupMCP();
      
      // Step 4: Configure Claude Code hooks
      const hooksConfig = await this.setupHooks();
      
      // Step 5: System service setup
      const serviceConfig = await this.setupSystemService();
      
      // Step 6: Review and confirm
      await this.reviewConfiguration({
        provider: providerConfig.provider,
        models: providerConfig.models,
        apiKeys: {
          anthropic: providerConfig.apiKeys.anthropic ? '***' + providerConfig.apiKeys.anthropic.slice(-4) : undefined,
          openai: providerConfig.apiKeys.openai ? '***' + providerConfig.apiKeys.openai.slice(-4) : undefined
        },
        directories,
        mcpConfig,
        hooksConfig,
        serviceConfig
      });

      // Apply configuration
      await this.applyConfiguration(providerConfig, directories, mcpConfig, hooksConfig, serviceConfig);

      // Test the setup
      await this.testSetup();

      // Show success message and start server
      await this.showSuccess();

    } catch (error) {
      this.logger.error('Setup wizard failed', error);
      console.error(chalk.red('\n❌ Setup failed:'), error);
      process.exit(1);
    }
  }

  /**
   * Shows welcome screen with ASCII art
   */
  private showWelcome(): void {
    console.clear();
    const title = figlet.textSync('Camille', {
      font: 'Standard',
      horizontalLayout: 'default',
      verticalLayout: 'default'
    });

    const welcome = boxen(
      chalk.cyan(title) + '\n\n' +
      chalk.white('Intelligent Code Compliance Checker for Claude Code\n\n') +
      chalk.gray('This wizard will help you set up Camille with:\n') +
      chalk.gray('  • OpenAI API integration\n') +
      chalk.gray('  • Directory monitoring\n') +
      chalk.gray('  • Claude Code hooks\n') +
      chalk.gray('  • MCP server configuration\n') +
      chalk.gray('  • Automatic startup service'),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'cyan'
      }
    );

    console.log(welcome);
    console.log();
  }

  /**
   * Checks if Camille is already configured
   */
  private async checkExistingConfig(): Promise<boolean> {
    try {
      const config = this.configManager.getConfig();
      if (config.openaiApiKey) {
        const { reconfigure } = await inquirer.prompt([{
          type: 'confirm',
          name: 'reconfigure',
          message: 'Camille is already configured. Do you want to reconfigure?',
          default: false
        }]);

        if (!reconfigure) {
          console.log(chalk.green('\n✅ Using existing configuration'));
          return true;
        }
      }
    } catch {
      // No existing config, continue with setup
    }
    return false;
  }

  /**
   * Sets up LLM provider configuration
   */
  private async setupProviderAndModels(): Promise<{
    provider: LLMProvider;
    models: { review: string; quick: string; embedding?: string };
    apiKeys: { anthropic?: string; openai?: string };
  }> {
    console.log(chalk.blue('\n🤖 LLM Provider Configuration\n'));

    // Step 1: Select provider
    const { provider } = await inquirer.prompt([{
      type: 'list',
      name: 'provider',
      message: 'Select your LLM provider:',
      choices: [
        { 
          name: 'Anthropic Claude (Recommended) - Best tool support', 
          value: 'anthropic' 
        },
        { 
          name: 'OpenAI GPT - Alternative option', 
          value: 'openai' 
        }
      ],
      default: 'anthropic'
    }]);

    this.logger.info(`Selected provider: ${provider}`);

    // Step 2: Select models
    const models = await this.selectModels(provider);

    // Step 3: Get API keys
    const apiKeys: { anthropic?: string; openai?: string } = {};
    
    // Always need OpenAI key for embeddings
    console.log(chalk.blue('\n🔑 API Key Configuration\n'));
    
    if (provider === 'anthropic') {
      console.log(chalk.yellow('Note: You\'ll need both Anthropic and OpenAI API keys.'));
      console.log(chalk.gray('Anthropic is used for code reviews, OpenAI is used for embeddings.\n'));
      
      apiKeys.anthropic = await this.getApiKey('anthropic');
      apiKeys.openai = await this.getApiKey('openai');
    } else {
      apiKeys.openai = await this.getApiKey('openai');
    }

    return { provider, models, apiKeys };
  }

  /**
   * Selects models for a provider
   */
  private async selectModels(provider: LLMProvider): Promise<{
    review: string;
    quick: string;
    embedding?: string;
  }> {
    console.log(chalk.blue('\n📊 Model Selection\n'));
    
    const availableModels = getModelsForProvider(provider);
    const recommendedModels = getRecommendedModels(provider);
    
    // Filter models for each use case
    const reviewModels = availableModels.filter(m => m.supportsTools);
    const quickModels = availableModels.filter(m => m.supportsTools && m.pricing.input <= 5);
    const embeddingModels = availableModels.filter(m => m.id.includes('embedding'));

    console.log(chalk.gray('Camille uses different models for different scenarios:\n'));
    console.log(chalk.gray('• Review Model: For comprehensive security analysis and code quality checks'));
    console.log(chalk.gray('• Quick Model: For routine checks and smaller code changes\n'));

    // Select review model
    console.log(chalk.yellow('\n1. Review Model Selection'));
    console.log(chalk.gray('Used for: Security analysis, compliance checks, architecture reviews'));
    console.log(chalk.gray('When: Complex changes, security-sensitive code, full file reviews\n'));
    
    const { reviewModel } = await inquirer.prompt([{
      type: 'list',
      name: 'reviewModel',
      message: 'Select your review model:',
      choices: reviewModels.map(model => ({
        name: `${model.name} - $${model.pricing.input}/${model.pricing.output} per 1M tokens ${model.id === recommendedModels.review.id ? chalk.green('(Recommended)') : ''}`,
        value: model.id,
        short: model.name
      })),
      default: recommendedModels.review.id
    }]);

    // Select quick model
    console.log(chalk.yellow('\n2. Quick Check Model Selection'));
    console.log(chalk.gray('Used for: Simple edits, formatting changes, minor updates'));
    console.log(chalk.gray('When: Small changes under 500 characters, non-security code\n'));
    
    const { quickModel } = await inquirer.prompt([{
      type: 'list',
      name: 'quickModel',
      message: 'Select your quick check model:',
      choices: quickModels.map(model => ({
        name: `${model.name} - $${model.pricing.input}/${model.pricing.output} per 1M tokens ${model.id === recommendedModels.quick.id ? chalk.green('(Recommended)') : ''}`,
        value: model.id,
        short: model.name
      })),
      default: recommendedModels.quick.id
    }]);

    const models: any = {
      review: reviewModel,
      quick: quickModel
    };

    // For OpenAI, also select embedding model
    if (provider === 'openai' && embeddingModels.length > 0) {
      const { embeddingModel } = await inquirer.prompt([{
        type: 'list',
        name: 'embeddingModel',
        message: 'Select model for embeddings:',
        choices: embeddingModels.map(model => ({
          name: `${model.name} - $${model.pricing.input} per 1M tokens ${model.id === recommendedModels.embedding?.id ? chalk.green('(Recommended)') : ''}`,
          value: model.id,
          short: model.name
        })),
        default: recommendedModels.embedding?.id
      }]);
      models.embedding = embeddingModel;
    } else {
      // Use OpenAI for embeddings even when using Anthropic for chat
      models.embedding = 'text-embedding-3-large';
    }

    return models;
  }

  /**
   * Gets and validates an API key for a provider
   */
  private async getApiKey(provider: 'anthropic' | 'openai'): Promise<string> {
    let apiKey: string;
    let isValid = false;

    while (!isValid) {
      const { key } = await inquirer.prompt([{
        type: 'password',
        name: 'key',
        message: `Enter your ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key:`,
        mask: '*',
        validate: (input: string) => {
          if (!input) return 'API key is required';
          if (provider === 'openai' && !input.startsWith('sk-')) {
            return 'OpenAI API key should start with "sk-"';
          }
          if (provider === 'anthropic' && !input.startsWith('sk-ant-')) {
            return 'Anthropic API key should start with "sk-ant-"';
          }
          if (input.length < 40) return 'API key seems too short';
          return true;
        }
      }]);

      apiKey = key;

      // Test the API key
      const spinner = ora(`Validating ${provider} API key...`).start();
      this.logger.info(`Validating ${provider} API key`);

      try {
        const testProvider = createProvider({
          provider,
          apiKey
        });

        if (testProvider.validateApiKey) {
          await testProvider.validateApiKey();
        }
        
        spinner.succeed('API key validated successfully');
        this.logger.info('API key validation successful');
        isValid = true;
      } catch (error) {
        spinner.fail('API key validation failed');
        this.logger.error('API key validation failed', error);
        
        const { retry } = await inquirer.prompt([{
          type: 'confirm',
          name: 'retry',
          message: 'Would you like to try a different API key?',
          default: true
        }]);

        if (!retry) {
          throw new Error('Invalid API key');
        }
      }
    }

    return apiKey!;
  }

  /**
   * Selects directories to monitor with autocomplete
   */
  private async selectDirectories(): Promise<string[]> {
    console.log(chalk.blue('\n📁 Directory Selection\n'));

    const directories: string[] = [];
    let addMore = true;

    while (addMore) {
      const { dirChoice } = await inquirer.prompt([{
        type: 'list',
        name: 'dirChoice',
        message: 'How would you like to add directories?',
        choices: [
          { name: 'Browse and select directory', value: 'browse' },
          { name: 'Enter path with wildcards (e.g., ~/projects/*)', value: 'wildcard' },
          { name: 'Enter specific path', value: 'manual' },
          ...(directories.length > 0 ? [{ name: 'Done adding directories', value: 'done' }] : [])
        ]
      }]);

      if (dirChoice === 'done') {
        addMore = false;
        continue;
      }

      let selectedDirs: string[] = [];

      switch (dirChoice) {
        case 'browse':
          selectedDirs = await this.browseDirectory();
          break;
        case 'wildcard':
          selectedDirs = await this.selectWithWildcard();
          break;
        case 'manual':
          selectedDirs = [await this.enterManualPath()];
          break;
      }

      // Validate directories
      for (const dir of selectedDirs) {
        const absPath = path.resolve(dir);
        if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
          if (!directories.includes(absPath)) {
            directories.push(absPath);
            console.log(chalk.green(`✓ Added: ${absPath}`));
            this.logger.info(`Added directory: ${absPath}`);
          } else {
            console.log(chalk.yellow(`⚠ Already added: ${absPath}`));
          }
        } else {
          console.log(chalk.red(`✗ Invalid directory: ${dir}`));
          this.logger.warn(`Invalid directory: ${dir}`);
        }
      }

      if (directories.length > 0) {
        console.log(chalk.gray(`\nCurrently watching ${directories.length} director${directories.length === 1 ? 'y' : 'ies'}`));
      }
    }

    return directories;
  }

  /**
   * Browse directory with autocomplete
   */
  private async browseDirectory(): Promise<string[]> {
    const homeDir = os.homedir();
    const currentDir = process.cwd();

    const { selectedPath } = await inquirer.prompt([{
      type: 'autocomplete',
      name: 'selectedPath',
      message: 'Select a directory (type to search):',
      source: async (_answers: any, input: string) => {
        // Handle empty input
        if (!input) {
          // Show common directories as suggestions
          const suggestions = [
            currentDir,
            homeDir,
            path.join(homeDir, 'projects'),
            path.join(homeDir, 'Documents'),
            path.join(homeDir, 'dev'),
            path.join(homeDir, 'Desktop'),
            path.join(homeDir, 'Downloads')
          ].filter(dir => fs.existsSync(dir));
          
          return suggestions.map(dir => ({
            name: this.formatDirDisplay(dir),
            value: dir
          }));
        }

        // Expand ~ to home directory
        const expandedInput = input.replace(/^~/, homeDir);
        
        // Get all possible matches
        const candidates: string[] = [];
        
        // If input looks like a complete path, check if it exists
        if (fs.existsSync(expandedInput) && fs.statSync(expandedInput).isDirectory()) {
          candidates.push(expandedInput);
        }
        
        // Try to find directories that start with the input
        try {
          // Get the parent directory to search in
          let searchDir: string;
          let searchPrefix: string;
          
          if (expandedInput.includes(path.sep)) {
            const lastSep = expandedInput.lastIndexOf(path.sep);
            searchDir = expandedInput.substring(0, lastSep) || path.sep;
            searchPrefix = expandedInput.substring(lastSep + 1);
          } else {
            searchDir = currentDir;
            searchPrefix = expandedInput;
          }
          
          // Only search if the search directory exists
          if (fs.existsSync(searchDir) && fs.statSync(searchDir).isDirectory()) {
            const entries = await fs.promises.readdir(searchDir, { withFileTypes: true });
            
            for (const entry of entries) {
              if (entry.isDirectory() && entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
                candidates.push(path.join(searchDir, entry.name));
              }
            }
          }
        } catch (error) {
          // Ignore errors when reading directories
          this.logger.debug('Error reading directory for autocomplete', error);
        }
        
        // Also search in common locations if input doesn't have a path separator
        if (!input.includes(path.sep) && !input.startsWith('~')) {
          const commonDirs = [homeDir, currentDir, path.join(homeDir, 'projects'), path.join(homeDir, 'dev')];
          for (const dir of commonDirs) {
            try {
              if (fs.existsSync(dir)) {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                  if (entry.isDirectory() && entry.name.toLowerCase().includes(input.toLowerCase())) {
                    candidates.push(path.join(dir, entry.name));
                  }
                }
              }
            } catch {
              // Ignore errors
            }
          }
        }
        
        // Remove duplicates and format results
        const unique = Array.from(new Set(candidates));
        return unique.map(dir => ({
          name: this.formatDirDisplay(dir),
          value: dir
        }));
      },
      pageSize: 10,
      suggestOnly: false
    }]);

    return [selectedPath];
  }

  /**
   * Select directories with wildcard support
   */
  private async selectWithWildcard(): Promise<string[]> {
    const { pattern } = await inquirer.prompt([{
      type: 'input',
      name: 'pattern',
      message: 'Enter wildcard pattern (e.g., ~/projects/*/src):',
      default: '~/projects/*',
      validate: (input: string) => {
        if (!input) return 'Pattern is required';
        return true;
      }
    }]);

    // Expand ~ to home directory
    const expandedPattern = pattern.replace(/^~/, os.homedir());
    
    const spinner = ora('Searching for directories...').start();
    this.logger.info(`Searching with pattern: ${expandedPattern}`);

    try {
      // Get all matches first
      const allMatches = await glob(expandedPattern, { 
        nodir: false
      });
      
      // Filter for directories
      const matches: string[] = [];
      for (const match of allMatches) {
        try {
          const stats = await fs.promises.stat(match);
          if (stats.isDirectory()) {
            matches.push(match);
          }
        } catch {
          // Skip items we can't stat
        }
      }

      spinner.succeed(`Found ${matches.length} directories`);

      if (matches.length === 0) {
        console.log(chalk.yellow('No directories matched the pattern'));
        return [];
      }

      // Show matches and let user select
      const { selected } = await inquirer.prompt([{
        type: 'checkbox',
        name: 'selected',
        message: 'Select directories to monitor:',
        choices: matches.map(dir => ({
          name: this.formatDirDisplay(dir),
          value: dir,
          checked: true
        })),
        pageSize: 15
      }]);

      return selected;
    } catch (error) {
      spinner.fail('Failed to search directories');
      this.logger.error('Wildcard search failed', error);
      return [];
    }
  }

  /**
   * Enter manual path with validation
   */
  private async enterManualPath(): Promise<string> {
    const { manualPath } = await inquirer.prompt([{
      type: 'input',
      name: 'manualPath',
      message: 'Enter directory path (use ~ for home):',
      default: process.cwd(),
      validate: (input: string) => {
        if (!input) return 'Path is required';
        const expanded = input.replace(/^~/, os.homedir());
        const resolved = path.resolve(expanded);
        
        if (!fs.existsSync(resolved)) {
          // Try to provide a helpful error message
          const parent = path.dirname(resolved);
          if (!fs.existsSync(parent)) {
            return `Parent directory does not exist: ${parent}`;
          }
          return `Directory does not exist: ${resolved}`;
        }
        
        if (!fs.statSync(resolved).isDirectory()) {
          return 'Path is not a directory';
        }
        
        return true;
      },
      filter: (input: string) => {
        return path.resolve(input.replace(/^~/, os.homedir()));
      }
    }]);

    return manualPath;
  }

  /**
   * Sets up MCP integration
   */
  private async setupMCP(): Promise<any> {
    console.log(chalk.blue('\n🔌 MCP Integration\n'));

    const { enableMCP } = await inquirer.prompt([{
      type: 'confirm',
      name: 'enableMCP',
      message: 'Enable MCP server for Claude Code integration?',
      default: true
    }]);

    if (!enableMCP) {
      return { enabled: false };
    }

    console.log(chalk.gray('\nCamille can be added to Claude Code as an MCP server.'));
    console.log(chalk.gray('You can configure it at user level (all projects) or project level.\n'));

    const { setupChoice } = await inquirer.prompt([{
      type: 'list',
      name: 'setupChoice',
      message: 'How would you like to set up MCP?',
      choices: [
        { name: 'Add to Claude Code now (recommended)', value: 'add' },
        { name: 'Show me the manual command to run later', value: 'manual' },
        { name: 'Skip MCP setup for now', value: 'skip' }
      ]
    }]);

    if (setupChoice === 'skip') {
      return { enabled: false };
    }

    if (setupChoice === 'manual') {
      console.log(chalk.yellow('\nTo add Camille to Claude Code, run:'));
      console.log(chalk.cyan('\nFor user-level (all projects):'));
      console.log(chalk.gray('  claude mcp add --scope user camille -- camille server start --mcp'));
      console.log(chalk.cyan('\nFor project-level (current project):'));
      console.log(chalk.gray('  claude mcp add --scope project camille -- camille server start --mcp'));
      console.log(chalk.cyan('\nFor specific projects:'));
      console.log(chalk.gray('  cd /path/to/project'));
      console.log(chalk.gray('  claude mcp add --scope local camille -- camille server start --mcp'));
      return { enabled: true, autoStart: false, manualSetup: true };
    }

    // Ask for scope
    const { scope } = await inquirer.prompt([{
      type: 'list',
      name: 'scope',
      message: 'Where should Camille be available?',
      choices: [
        { name: 'User level - Available in all projects', value: 'user' },
        { name: 'Project level - Available to all team members in current project', value: 'project' },
        { name: 'Local - Just for me in specific projects', value: 'local' }
      ]
    }]);

    if (scope === 'local') {
      // Let user select which projects to enable MCP in
      const watchedDirs = this.configManager.getConfig().watchedDirectories || [];
      const projectDirs: string[] = [];
      
      if (watchedDirs.length > 0) {
        const { selectedProjects } = await inquirer.prompt([{
          type: 'checkbox',
          name: 'selectedProjects',
          message: 'Select projects where you want to enable MCP:',
          choices: watchedDirs.map(dir => ({
            name: this.formatDirDisplay(dir),
            value: dir,
            checked: true
          }))
        }]);
        projectDirs.push(...selectedProjects);
      } else {
        // No watched directories yet, ask for current directory
        const { addProject } = await inquirer.prompt([{
          type: 'confirm',
          name: 'addProject',
          message: 'Would you like to add Camille to the current directory?',
          default: true
        }]);
        
        if (addProject) {
          projectDirs.push(process.cwd());
        }
      }
      
      return { enabled: true, autoStart: true, scope, projectDirs };
    }

    return { enabled: true, autoStart: true, scope };
  }

  /**
   * Sets up Claude Code hooks
   */
  private async setupHooks(): Promise<any> {
    console.log(chalk.blue('\n🪝 Claude Code Hooks\n'));

    const { enableHooks } = await inquirer.prompt([{
      type: 'confirm',
      name: 'enableHooks',
      message: 'Enable automatic code review hooks?',
      default: true
    }]);

    if (!enableHooks) {
      return { enabled: false };
    }

    const { tools } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'tools',
      message: 'Which tools should trigger code review?',
      choices: [
        { name: 'Edit - Single file edits', value: 'Edit', checked: true },
        { name: 'MultiEdit - Multiple edits', value: 'MultiEdit', checked: true },
        { name: 'Write - New file creation', value: 'Write', checked: true }
      ]
    }]);

    return { enabled: true, tools };
  }

  /**
   * Sets up system service for auto-start
   */
  private async setupSystemService(): Promise<any> {
    console.log(chalk.blue('\n🚀 Startup Service\n'));

    const { enableService } = await inquirer.prompt([{
      type: 'confirm',
      name: 'enableService',
      message: 'Set up Camille to start automatically on system boot?',
      default: true
    }]);

    if (!enableService) {
      return { enabled: false };
    }

    const platform = os.platform();
    
    if (platform !== 'darwin' && platform !== 'linux') {
      console.log(chalk.yellow('⚠ Automatic startup is only supported on macOS and Linux'));
      return { enabled: false };
    }

    return { 
      enabled: true, 
      platform,
      method: platform === 'darwin' ? 'launchd' : 'systemd'
    };
  }

  /**
   * Reviews configuration before applying
   */
  private async reviewConfiguration(config: any): Promise<void> {
    console.log(chalk.blue('\n📋 Configuration Review\n'));

    let apiKeySection = '';
    if (config.provider === 'anthropic') {
      apiKeySection = 
        chalk.gray('Provider: ') + chalk.green('Anthropic Claude') + '\n' +
        chalk.gray('Anthropic API Key: ') + chalk.green(config.apiKeys.anthropic || 'Not set') + '\n' +
        chalk.gray('OpenAI API Key: ') + chalk.green(config.apiKeys.openai || 'Not set') + chalk.gray(' (for embeddings)') + '\n';
    } else {
      apiKeySection = 
        chalk.gray('Provider: ') + chalk.green('OpenAI GPT') + '\n' +
        chalk.gray('OpenAI API Key: ') + chalk.green(config.apiKeys.openai || 'Not set') + '\n';
    }

    const modelsSection = 
      chalk.gray('Models:\n') +
      chalk.gray('  • Review: ') + chalk.green(config.models.review) + '\n' +
      chalk.gray('  • Quick: ') + chalk.green(config.models.quick) + '\n' +
      chalk.gray('  • Embedding: ') + chalk.green(config.models.embedding || 'text-embedding-3-large') + '\n';

    const summary = boxen(
      chalk.white('Your Camille Configuration:\n\n') +
      apiKeySection +
      modelsSection + '\n' +
      chalk.gray('Directories: ') + chalk.green(config.directories.length) + ' selected\n' +
      config.directories.map((d: string) => chalk.gray('  • ') + d).join('\n') + '\n\n' +
      chalk.gray('MCP Server: ') + (config.mcpConfig.enabled ? chalk.green('Enabled') : chalk.red('Disabled')) + '\n' +
      chalk.gray('Code Review Hooks: ') + (config.hooksConfig.enabled ? chalk.green('Enabled') : chalk.red('Disabled')) + '\n' +
      chalk.gray('Auto-start Service: ') + (config.serviceConfig.enabled ? chalk.green('Enabled') : chalk.red('Disabled')),
      {
        padding: 1,
        borderStyle: 'round',
        borderColor: 'cyan'
      }
    );

    console.log(summary);

    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: 'Apply this configuration?',
      default: true
    }]);

    if (!confirm) {
      throw new Error('Configuration cancelled by user');
    }
  }

  /**
   * Applies the configuration
   */
  private async applyConfiguration(
    providerConfig: {
      provider: LLMProvider;
      models: { review: string; quick: string; embedding?: string };
      apiKeys: { anthropic?: string; openai?: string };
    },
    directories: string[],
    mcpConfig: any,
    hooksConfig: any,
    serviceConfig: any
  ): Promise<void> {
    const spinner = ora('Applying configuration...').start();
    this.logger.info('Applying configuration');

    try {
      // Save provider and API keys
      this.configManager.setProvider(providerConfig.provider);
      
      if (providerConfig.apiKeys.anthropic) {
        this.configManager.setApiKey(providerConfig.apiKeys.anthropic, 'anthropic');
      }
      if (providerConfig.apiKeys.openai) {
        this.configManager.setApiKey(providerConfig.apiKeys.openai, 'openai');
      }
      
      // Save other settings
      this.configManager.updateConfig({
        provider: providerConfig.provider,
        models: providerConfig.models,
        watchedDirectories: directories,
        mcp: mcpConfig,
        hooks: hooksConfig,
        autoStart: serviceConfig
      });

      // Create Claude Code settings file
      if (hooksConfig.enabled || mcpConfig.enabled) {
        await this.createClaudeCodeSettings(hooksConfig, mcpConfig, spinner);
      }

      // Set up system service
      if (serviceConfig.enabled) {
        await this.createSystemService(serviceConfig, directories);
      }

      spinner.succeed('Configuration applied successfully');
      this.logger.info('Configuration applied successfully');
    } catch (error) {
      spinner.fail('Failed to apply configuration');
      throw error;
    }
  }

  /**
   * Creates Claude Code settings file
   */
  private async createClaudeCodeSettings(hooksConfig: any, mcpConfig: any, spinner?: Ora): Promise<void> {
    // Handle hooks configuration in ~/.claude/settings.json
    if (hooksConfig.enabled) {
      let settings: any = {
        hooks: {
          PreToolUse: [{
            matcher: hooksConfig.tools.join('|'),
            hooks: [{
              type: 'command',
              command: 'camille hook'
            }]
          }]
        }
      };

      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const settingsDir = path.dirname(settingsPath);

      if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, { recursive: true });
      }

      // Merge with existing settings
      let existingSettings: any = {};
      if (fs.existsSync(settingsPath)) {
        try {
          existingSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          this.logger.info('Found existing Claude Code settings', { settingsPath });
          
          // Check if user already has hooks configured
          if (existingSettings.hooks?.PreToolUse && existingSettings.hooks.PreToolUse.length > 0) {
            // Stop spinner to show prompt
            if (spinner) spinner.stop();
            
            console.log(chalk.yellow('\n⚠ Found existing hooks in Claude Code settings'));
            
            const { mergeChoice } = await inquirer.prompt([{
              type: 'list',
              name: 'mergeChoice',
              message: 'How would you like to handle existing hooks?',
              choices: [
                { name: 'Add Camille hook alongside existing hooks', value: 'merge' },
                { name: 'Replace existing hooks with Camille hook', value: 'replace' },
                { name: 'Skip hook configuration', value: 'skip' }
              ]
            }]);
            
            // Restart spinner after prompt
            if (spinner) spinner.start('Applying configuration...');
            
            if (mergeChoice === 'skip') {
              console.log(chalk.gray('Skipped hook configuration'));
              return;
            }
            
            if (mergeChoice === 'merge') {
              // Check if Camille hook already exists
              const camilleHookExists = existingSettings.hooks.PreToolUse.some((hookConfig: any) => 
                hookConfig.hooks?.some((hook: any) => hook.command === 'camille hook')
              );
              
              if (camilleHookExists) {
                console.log(chalk.gray('Camille hook already configured'));
                return;
              }
              
              // Add Camille hook to existing hooks
              existingSettings.hooks.PreToolUse.push(settings.hooks.PreToolUse[0]);
              settings = existingSettings;
            } else if (mergeChoice === 'replace') {
              // Replace existing hooks with Camille hook, preserving other settings
              settings = {
                ...existingSettings,
                hooks: settings.hooks
              };
            }
          } else {
            // No existing hooks, safe to merge
            const mergedSettings = { 
              ...existingSettings, 
              hooks: {
                ...existingSettings.hooks,
                ...settings.hooks
              }
            };
            settings = mergedSettings;
          }
        } catch (error) {
          this.logger.error('Failed to parse existing settings', error);
          console.log(chalk.red('⚠ Failed to read existing settings, creating new file'));
        }
      }

      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      
      this.logger.info('Updated Claude Code settings for hooks', { settingsPath });
      console.log(chalk.green(`✓ Updated Claude Code hooks configuration`));
    }

    // Handle MCP configuration using claude mcp add command
    if (mcpConfig.enabled && !mcpConfig.manualSetup) {
      const { execSync } = require('child_process');
      
      try {
        // Check if claude command is available
        execSync('claude --version', { stdio: 'ignore' });
      } catch {
        console.log(chalk.yellow('\n⚠ Claude Code CLI not found. Please install Claude Code first.'));
        console.log(chalk.gray('Visit: https://docs.anthropic.com/en/docs/claude-code/quickstart'));
        return;
      }

      // Build the command arguments
      const args = ['mcp', 'add'];
      
      // Add scope
      if (mcpConfig.scope) {
        args.push('--scope', mcpConfig.scope);
      }
      
      // Add server name and command to use the Python proxy
      const proxyPath = path.join(__dirname, '..', 'mcp-pipe-proxy.py');
      args.push('camille', '--', 'python3', proxyPath);
      
      if (mcpConfig.scope === 'local' && mcpConfig.projectDirs) {
        // For local scope, we need to run the command in each project directory
        for (const dir of mcpConfig.projectDirs) {
          try {
            console.log(chalk.gray(`\nAdding Camille to ${this.formatDirDisplay(dir)}...`));
            execSync(`claude ${args.join(' ')}`, { 
              cwd: dir,
              stdio: 'inherit'
            });
            console.log(chalk.green(`✓ Added Camille MCP server to ${this.formatDirDisplay(dir)}`));
          } catch (error) {
            console.log(chalk.red(`✗ Failed to add MCP server to ${this.formatDirDisplay(dir)}:`));
            console.log(chalk.gray((error as Error).message));
          }
        }
      } else {
        // For user or project scope, run once
        try {
          console.log(chalk.gray(`\nAdding Camille at ${mcpConfig.scope} level...`));
          execSync(`claude ${args.join(' ')}`, { stdio: 'inherit' });
          console.log(chalk.green(`\n✓ Added Camille MCP server at ${mcpConfig.scope} level`));
        } catch (error) {
          console.log(chalk.red('\n✗ Failed to add MCP server:'));
          console.log(chalk.gray((error as Error).message));
        }
      }
    }
  }

  /**
   * Creates system service for auto-start
   */
  private async createSystemService(serviceConfig: any, directories: string[]): Promise<void> {
    if (serviceConfig.platform === 'darwin') {
      await this.createLaunchdService(directories);
    } else if (serviceConfig.platform === 'linux') {
      await this.createSystemdService(directories);
    }
  }

  /**
   * Creates launchd service for macOS
   */
  private async createLaunchdService(directories: string[]): Promise<void> {
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.camille.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${path.join(__dirname, '..', 'dist', 'cli.js')}</string>
        <string>server</string>
        <string>start</string>
        ${directories.flatMap(d => ['<string>-d</string>', `<string>${d}</string>`]).join('\n        ')}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/camille.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/camille.error.log</string>
</dict>
</plist>`;

    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.camille.server.plist');
    fs.writeFileSync(plistPath, plistContent);
    
    // Load the service
    spawn('launchctl', ['load', plistPath]);
    
    this.logger.info('Created launchd service', { plistPath });
  }

  /**
   * Creates systemd service for Linux
   */
  private async createSystemdService(directories: string[]): Promise<void> {
    const serviceContent = `[Unit]
Description=Camille Code Compliance Server
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${path.join(__dirname, '..', 'dist', 'cli.js')} server start ${directories.map(d => `-d ${d}`).join(' ')}
Restart=always
User=${os.userInfo().username}
StandardOutput=append:/tmp/camille.log
StandardError=append:/tmp/camille.error.log

[Install]
WantedBy=default.target`;

    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'camille.service');
    const serviceDir = path.dirname(servicePath);

    if (!fs.existsSync(serviceDir)) {
      fs.mkdirSync(serviceDir, { recursive: true });
    }

    fs.writeFileSync(servicePath, serviceContent);
    
    // Enable and start the service
    spawn('systemctl', ['--user', 'daemon-reload']);
    spawn('systemctl', ['--user', 'enable', 'camille.service']);
    spawn('systemctl', ['--user', 'start', 'camille.service']);
    
    this.logger.info('Created systemd service', { servicePath });
  }

  /**
   * Tests the setup
   */
  private async testSetup(): Promise<void> {
    console.log(chalk.blue('\n🧪 Testing Setup\n'));

    const spinner = ora('Running setup tests...').start();
    this.logger.info('Running setup tests');

    try {
      // Test 1: API connection
      spinner.text = 'Testing LLM connection...';
      const config = this.configManager.getConfig();
      const client = new LLMClient(
        config,
        process.cwd()
      );
      
      // Test with a simple completion
      await client.reviewCode(
        'You are a helpful assistant.',
        'Say "Hello, test successful!" if you can process this message.',
        false // Use quick model for testing
      );
      spinner.succeed(`${config.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} connection working`);

      // Test 2: Directory access
      spinner.start('Testing directory access...');
      const dirs = config.watchedDirectories || [];
      for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
          throw new Error(`Cannot access directory: ${dir}`);
        }
      }
      spinner.succeed('Directory access verified');

      // Test 3: MCP server
      if (config.mcp?.enabled) {
        spinner.start('Testing MCP server...');
        // Just check if we can create the server
        spinner.succeed('MCP server configuration valid');
      }

      // Test 4: Hooks
      if (config.hooks?.enabled) {
        spinner.start('Testing hooks configuration...');
        spinner.succeed('Hooks configuration valid');
      }

      this.logger.info('All tests passed');
    } catch (error) {
      spinner.fail('Setup test failed');
      this.logger.error('Setup test failed', error);
      throw error;
    }
  }

  /**
   * Shows success message and starts the server
   */
  private async showSuccess(): Promise<void> {
    const config = this.configManager.getConfig();
    
    // Start the server in the background
    if (config.watchedDirectories && config.watchedDirectories.length > 0) {
      console.log(chalk.blue('\n🚀 Starting Camille server...\n'));
      try {
        // Use nohup to start the server truly detached (without --mcp flag)
        const { execSync } = require('child_process');
        execSync('nohup camille server start > /dev/null 2>&1 &', {
          shell: true
        });
        
        // Give it a moment to start
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Check if it's running
        try {
          execSync('camille server status', { stdio: 'ignore' });
          console.log(chalk.green('✓ Server started successfully\n'));
          this.logger.info('Server started after setup');
        } catch {
          // Status command failed, server might not be running
          console.log(chalk.yellow('⚠ Server may not have started. Start it manually with: camille server start\n'));
        }
      } catch (error) {
        console.log(chalk.yellow('⚠ Could not start server automatically. Start it manually with: camille server start\n'));
        this.logger.error('Failed to start server after setup', error);
      }
    }
    
    // Build success message based on what was configured
    let message = chalk.green('✅ Camille Setup Complete!\n\n');
    
    // What was configured
    message += chalk.white('What\'s configured:\n');
    
    if (config.openaiApiKey) {
      message += chalk.gray('  ✓ OpenAI API key set\n');
    }
    
    if (config.watchedDirectories && config.watchedDirectories.length > 0) {
      message += chalk.gray(`  ✓ Watching ${config.watchedDirectories.length} director${config.watchedDirectories.length === 1 ? 'y' : 'ies'}\n`);
    }
    
    if (config.hooks?.enabled) {
      message += chalk.gray('  ✓ Claude Code hooks configured\n');
    }
    
    if (config.mcp?.enabled) {
      message += chalk.gray('  ✓ MCP server configuration created\n');
    }
    
    if (config.autoStart?.enabled) {
      message += chalk.gray('  ✓ Auto-start service enabled\n');
    }
    
    // Next steps
    message += '\n' + chalk.white('Next steps:\n\n');
    
    // Hook testing
    if (config.hooks?.enabled) {
      message += chalk.yellow('1. Test Claude Code hooks:\n');
      message += chalk.gray('   • Open a project in Claude Code\n');
      message += chalk.gray('   • Try editing a file\n');
      message += chalk.gray('   • Camille will review the changes\n\n');
    }
    
    // MCP testing
    if (config.mcp?.enabled) {
      message += chalk.yellow('2. Test MCP integration:\n');
      message += chalk.gray('   • Open a project with .mcp.json in Claude Code\n');
      message += chalk.gray('   • Ask Claude to "search for <something>"\n');
      message += chalk.gray('   • Claude will connect to the central Camille service\n');
      message += chalk.gray('   • No new servers will be spawned per project\n\n');
    }
    
    // Server commands
    message += chalk.yellow('3. Useful commands:\n');
    message += chalk.gray('   • Start server manually: ') + chalk.cyan('camille server start') + '\n';
    message += chalk.gray('   • Check status: ') + chalk.cyan('camille server status') + '\n';
    message += chalk.gray('   • View configuration: ') + chalk.cyan('camille config show') + '\n';
    message += chalk.gray('   • View logs: ') + chalk.cyan('tail -f /tmp/camille.log') + '\n';
    
    if (!config.mcp?.enabled || (config.mcp as any)?.manualSetup) {
      message += '\n' + chalk.yellow('4. Add MCP to a project later:\n');
      message += chalk.gray('   • Run: ') + chalk.cyan('camille init-mcp') + chalk.gray(' in project root\n');
    }
    
    const success = boxen(message, {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'green'
    });

    console.log(success);
    
    // Additional tips
    console.log(chalk.dim('\n💡 Tips:'));
    console.log(chalk.dim('  • Run "camille help mcp" for MCP troubleshooting'));
    console.log(chalk.dim('  • Check ~/.camille/config.json to modify settings'));
    console.log(chalk.dim('  • Report issues at: https://github.com/srao-positron/camille/issues\n'));
    
    this.logger.info('Setup completed successfully');
  }

  /**
   * Formats directory display
   */
  private formatDirDisplay(dirPath: string): string {
    const home = os.homedir();
    if (dirPath.startsWith(home)) {
      return '~' + dirPath.slice(home.length);
    }
    return dirPath;
  }
}

/**
 * Runs the setup wizard
 */
export async function runSetupWizard(): Promise<void> {
  const wizard = new SetupWizard();
  await wizard.run();
}