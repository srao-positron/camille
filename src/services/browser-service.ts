import { BrowserRealtimeAuth } from './browser-realtime-auth.js';
import { logger } from '../logger.js';
import { createHash } from 'crypto';
import * as os from 'os';
import { SupabaseClient } from '@supabase/supabase-js';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { Database } from '../types/supabase.js';

type BrowserMachine = Database['public']['Tables']['browser_machines']['Row'];
type BrowserSession = Database['public']['Tables']['browser_sessions']['Row'];
type BrowserCommand = Database['public']['Tables']['browser_commands']['Row'];
type BrowserResult = Database['public']['Tables']['browser_results']['Insert'];

interface ActiveSession {
  context: BrowserContext;
  page: Page;
  sessionId: string;
  url: string;
  createdAt: Date;
}

export class BrowserService {
  private realtimeAuth: BrowserRealtimeAuth;
  private machineId: string;
  private machineName: string;
  private supabase?: SupabaseClient<Database>;
  private heartbeatInterval?: NodeJS.Timeout;
  private pollingInterval?: NodeJS.Timeout;
  private isShuttingDown = false;
  private browser?: Browser;
  private activeSessions: Map<string, ActiveSession> = new Map();
  private screenshotDir: string;
  private lastCommandId?: string;
  
  constructor() {
    // Load or generate machine ID
    this.machineId = this.loadOrGenerateMachineId();
    this.machineName = os.hostname() || `camille-${this.machineId.slice(0, 8)}`;
    this.realtimeAuth = new BrowserRealtimeAuth(this.machineId);
    
    // Create screenshots directory
    this.screenshotDir = path.join(os.tmpdir(), 'camille-screenshots');
  }
  
  async start() {
    try {
      // Initialize Realtime with API key exchange
      await this.realtimeAuth.initialize();
      
      // Get Supabase client
      this.supabase = this.realtimeAuth.getSupabase() as SupabaseClient<Database>;
      
      // Ensure screenshots directory exists
      await fs.mkdir(this.screenshotDir, { recursive: true });
      
      // Launch browser
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      logger.info('Browser launched successfully');
      
      // Register this machine
      await this.registerMachine();
      
      // Start heartbeat
      this.startHeartbeat();
      
      // Start polling for commands instead of using Realtime
      logger.info('Starting command polling service...');
      await this.startCommandPolling();
      
      logger.info(`Browser service started on machine ${this.machineName} (${this.machineId})`);
    } catch (error) {
      logger.error('Failed to start browser service:', error);
      throw error;
    }
  }
  
  private loadOrGenerateMachineId(): string {
    // Check for existing machine ID file
    const machineIdPath = path.join(os.homedir(), '.camille', 'machine-id');
    
    try {
      // Try to read existing machine ID
      const existingId = require('fs').readFileSync(machineIdPath, 'utf-8').trim();
      if (existingId && existingId.length === 16) {
        logger.info(`Loaded existing machine ID: ${existingId}`);
        return existingId;
      }
    } catch (error) {
      // File doesn't exist or is invalid, generate new ID
    }
    
    // Generate new machine ID
    const newId = this.generateMachineId();
    
    // Save the new ID for future runs
    try {
      require('fs').mkdirSync(path.dirname(machineIdPath), { recursive: true });
      require('fs').writeFileSync(machineIdPath, newId, 'utf-8');
      logger.info(`Generated and saved new machine ID: ${newId}`);
    } catch (error) {
      logger.warn(`Failed to save machine ID: ${error}`);
    }
    
    return newId;
  }
  
  private generateMachineId(): string {
    // Create a stable ID based on hostname
    const hostname = os.hostname();
    const hash = createHash('sha256');
    hash.update(hostname);
    hash.update(process.platform);
    hash.update(os.arch());
    
    // Try to get MAC address for additional uniqueness
    try {
      const networkInterfaces = os.networkInterfaces();
      for (const iface of Object.values(networkInterfaces)) {
        if (iface) {
          for (const addr of iface) {
            if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
              hash.update(addr.mac);
              break;
            }
          }
        }
      }
    } catch (error) {
      // Ignore MAC address errors
    }
    
    return hash.digest('hex').slice(0, 16);
  }
  
  private async registerMachine() {
    if (!this.supabase || !this.realtimeAuth.getUserId()) {
      throw new Error('Not initialized');
    }
    
    // Register or update machine
    const { data, error } = await this.supabase
      .from('browser_machines')
      .upsert({
        machine_id: this.machineId,
        machine_name: this.machineName,
        platform: process.platform,
        last_heartbeat: new Date().toISOString(),
        is_active: true,
        capabilities: {
          browsers: ['chrome'], // TODO: Detect available browsers
          maxSessions: 5,
          activeSessions: 0
        },
        user_id: this.realtimeAuth.getUserId()!
      }, {
        onConflict: 'machine_id'
      })
      .select()
      .single();
    
    if (error) {
      throw new Error(`Failed to register machine: ${error.message}`);
    }
    
    logger.info(`Machine registered: ${data.machine_name}`);
  }
  
  private startHeartbeat() {
    // Send heartbeat every 15 seconds (half of 30s timeout)
    this.heartbeatInterval = setInterval(async () => {
      if (this.isShuttingDown) return;
      
      try {
        // Count active sessions that have been updated in the last 5 minutes
        // Sessions without recent activity are considered stale
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { count: activeSessions } = await this.supabase!
          .from('browser_sessions')
          .select('*', { count: 'exact', head: true })
          .eq('machine_id', this.machineId)
          .eq('status', 'active')
          .gte('updated_at', fiveMinutesAgo);
        
        // Mark stale sessions as failed (sessions not updated in 5 minutes)
        await this.supabase!
          .from('browser_sessions')
          .update({ status: 'failed' })
          .eq('machine_id', this.machineId)
          .eq('status', 'active')
          .lt('updated_at', fiveMinutesAgo);
        
        // Update heartbeat and capabilities
        await this.supabase!.rpc('update_browser_machine_heartbeat', {
          p_machine_id: this.machineId,
          p_capabilities: {
            browsers: ['chrome'],
            maxSessions: 5,
            activeSessions: activeSessions || 0
          }
        });
      } catch (error) {
        logger.error('Heartbeat failed:', error);
      }
    }, 15000);
  }
  
  private async updateCommandStatus(commandId: string, status: 'completed' | 'failed') {
    try {
      const config = this.realtimeAuth.getConfig();
      const supabaseUrl = 'https://zqlfxakbkwssxfynrmnk.supabase.co';
      
      const response = await fetch(`${supabaseUrl}/functions/v1/update-command-status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Supastate-Auth': config.supastate?.apiKey || ''
        },
        body: JSON.stringify({
          commandId,
          status,
          processedAt: new Date().toISOString()
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Failed to update command status: ${errorText}`);
      }
    } catch (error) {
      logger.error(`Failed to update command status:`, error);
    }
  }
  
  private sseAbortController?: AbortController;
  private sseReconnectTimeout?: NodeJS.Timeout;
  
  private async startCommandPolling() {
    // Use SSE instead of polling for real-time command streaming
    await this.connectSSE();
  }
  
  private async connectSSE() {
    if (this.isShuttingDown) return;
    
    try {
      const config = this.realtimeAuth.getConfig();
      const apiKey = config.supastate?.apiKey || '';
      
      // Connect to production Supastate API
      const baseUrl = 'https://www.supastate.ai';
      const sseUrl = `${baseUrl}/api/browser/heartbeat`;
      
      logger.info(`Connecting to SSE endpoint: ${sseUrl}`);
      
      // Create abort controller for clean shutdown
      this.sseAbortController = new AbortController();
      
      const response = await fetch(sseUrl, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'x-machine-name': this.machineName,
          'Accept': 'text/event-stream',
        },
        signal: this.sseAbortController.signal,
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`SSE connection failed: ${response.status} ${errorText}`);
      }
      
      logger.info('SSE connection established');
      
      // Process the event stream
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (reader) {
        try {
          const { done, value } = await reader.read();
          
          if (done) {
            logger.info('SSE stream ended');
            break;
          }
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              try {
                const message = JSON.parse(data);
                await this.handleSSEMessage(message);
              } catch (error) {
                logger.error('Failed to parse SSE message:', { data, error });
              }
            } else if (line.startsWith(': ping')) {
              logger.debug('Received SSE ping');
            }
          }
        } catch (error: any) {
          if (error.name === 'AbortError') {
            logger.info('SSE connection aborted');
            break;
          }
          logger.error('SSE read error:', error);
          break;
        }
      }
    } catch (error) {
      logger.error('SSE connection error:', error);
    }
    
    // Reconnect after a delay if not shutting down
    if (!this.isShuttingDown) {
      logger.info('Scheduling SSE reconnection in 5 seconds...');
      this.sseReconnectTimeout = setTimeout(() => {
        this.connectSSE();
      }, 5000);
    }
  }
  
  private async handleSSEMessage(message: any) {
    switch (message.type) {
      case 'connected':
        logger.info('SSE connected', { 
          machineId: message.machineId,
          userId: message.userId,
          teamId: message.teamId 
        });
        // Store the machine ID from server
        this.machineId = message.machineId;
        break;
        
      case 'command':
        logger.info('Received command via SSE', { 
          commandId: message.command.id,
          command: message.command.command 
        });
        await this.handleCommand(message.command);
        this.lastCommandId = message.command.id;
        break;
        
      case 'heartbeat':
        logger.debug('Received heartbeat acknowledgment', { timestamp: message.timestamp });
        break;
        
      case 'cancel':
        logger.info('Command cancelled', { commandId: message.commandId });
        // Handle command cancellation if needed
        break;
        
      default:
        logger.warn('Unknown SSE message type', { type: message.type, message });
    }
  }
  
  private async handleCommand(command: BrowserCommand) {
    logger.info(`Processing command ${command.id}: ${command.command}`);
    
    const startTime = Date.now();
    let success = false;
    let error: string | null = null;
    let screenshotUrl: string | null = null;
    let domSnapshot: any = null;
    let domFileName: string | null = null;
    let consoleLogs: any[] = [];
    let session: ActiveSession | undefined;
    
    try {
      // Get or create session
      session = this.activeSessions.get(command.session_id);
      
      if (!session) {
        // Need to create session first - use Edge Function with API key auth
        const config = this.realtimeAuth.getConfig();
        const supabaseUrl = 'https://zqlfxakbkwssxfynrmnk.supabase.co';
        
        const response = await fetch(`${supabaseUrl}/functions/v1/get-browser-session`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Supastate-Auth': config.supastate?.apiKey || ''
          },
          body: JSON.stringify({ sessionId: command.session_id })
        });
        
        if (!response.ok) {
          throw new Error('Session not found');
        }
        
        const result = await response.json() as { session: BrowserSession };
        const sessionData = result.session;
        
        if (!sessionData) {
          throw new Error('Session not found');
        }
        
        // Create new browser context
        const context = await this.browser!.newContext({
          viewport: sessionData.viewport as { width: number; height: number } || { width: 1280, height: 720 },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        
        const page = await context.newPage();
        
        // Capture console logs
        page.on('console', msg => {
          consoleLogs.push({
            level: msg.type(),
            message: msg.text(),
            timestamp: new Date().toISOString()
          });
        });
        
        session = {
          context,
          page,
          sessionId: command.session_id,
          url: sessionData.url,
          createdAt: new Date()
        };
        
        this.activeSessions.set(command.session_id, session);
      }
      
      // Process the command
      const { page } = session;
      
      // Handle credentials if provided
      if (command.credentials) {
        // TODO: Implement credential handling
      }
      
      // Parse structured commands with pipe delimiters
      // Also handle function-style commands like screenshot() or captureDOM()
      let commandParts: string[];
      let action: string;
      
      if (command.command.includes('(') && command.command.includes(')')) {
        // Function-style command (e.g., screenshot(), captureDOM())
        const match = command.command.match(/^(\w+)\((.*)\)$/);
        if (match) {
          action = match[1].toLowerCase();
          commandParts = match[2] ? [action, ...match[2].split(',')] : [action];
        } else {
          // Fallback to pipe parsing
          commandParts = command.command.split('|');
          action = commandParts[0].toLowerCase();
        }
      } else {
        // Pipe-delimited command
        commandParts = command.command.split('|');
        action = commandParts[0].toLowerCase();
      }
      
      if (action === 'click') {
        // Format: click|selector
        if (commandParts.length >= 2) {
          const selector = commandParts[1];
          
          // Check if element exists
          const elementCount = await page.locator(selector).count();
          if (elementCount === 0) {
            const errorMsg = `No elements found for selector: ${selector}`;
            logger.error(errorMsg);
            
            // Try to provide helpful debugging info
            const buttons = await page.locator('button, a, [role="button"]').all();
            const buttonTexts = await Promise.all(
              buttons.slice(0, 5).map(async (btn) => {
                const text = await btn.textContent().catch(() => '');
                return text?.trim();
              })
            );
            logger.info(`Available clickable elements: ${buttonTexts.join(', ')}`);
            
            throw new Error(errorMsg);
          }
          
          const element = await page.locator(selector).first();
          
          // Check if this might be a navigation link
          const href = await element.getAttribute('href').catch(() => null);
          const isNavigationLink = href && !href.startsWith('#');
          
          await element.click();
          logger.info(`Clicked element with selector: ${selector}`);
          
          // If it's likely a navigation link, wait for navigation
          if (isNavigationLink || command.wait_for === 'navigation') {
            try {
              await page.waitForLoadState('networkidle', { timeout: 5000 });
              logger.info('Page settled after click');
            } catch {
              // Click might not navigate, that's OK
            }
          }
        }
        
      } else if (action === 'type' || action === 'fill') {
        // Format: type|selector|text or fill|selector|text
        if (commandParts.length >= 3) {
          const selector = commandParts[1];
          const text = commandParts.slice(2).join('|'); // Join in case text contains |
          logger.info(`Typing "${text}" into selector "${selector}"`);
          
          // Debug: Check current URL and element existence
          const currentUrl = page.url();
          logger.info(`Current page URL: ${currentUrl}`);
          
          // Check if element exists
          const elementCount = await page.locator(selector).count();
          logger.info(`Found ${elementCount} elements matching selector "${selector}"`);
          
          if (elementCount === 0) {
            // Try to find similar elements for debugging
            const inputs = await page.locator('input').all();
            logger.info(`Found ${inputs.length} input elements on page`);
            
            // Log first few inputs for debugging
            for (let i = 0; i < Math.min(3, inputs.length); i++) {
              const name = await inputs[i].getAttribute('name');
              const id = await inputs[i].getAttribute('id');
              const type = await inputs[i].getAttribute('type');
              logger.info(`  Input ${i}: name="${name}", id="${id}", type="${type}"`);
            }
            
            throw new Error(`No element found matching selector: ${selector}`);
          }
          
          const field = await page.locator(selector).first();
          await field.fill(text);
          logger.info(`Successfully typed text into ${selector}`);
        }
        
      } else if (action === 'navigate') {
        // Format: navigate|url
        if (commandParts.length >= 2) {
          const url = commandParts.slice(1).join('|'); // Join in case URL contains |
          logger.info(`Navigating to ${url}`);
          await page.goto(url, { waitUntil: 'networkidle' });
          logger.info(`Navigation to ${url} completed`);
        }
        
      } else if (action === 'scroll') {
        // Format: scroll|down|pixels or scroll|up|pixels or scroll|to|selector
        if (commandParts.length >= 2) {
          const direction = commandParts[1];
          if (direction === 'to' && commandParts.length >= 3) {
            const selector = commandParts[2];
            await page.locator(selector).first().scrollIntoViewIfNeeded();
            logger.info(`Scrolled to element: ${selector}`);
          } else if ((direction === 'down' || direction === 'up') && commandParts.length >= 3) {
            const pixels = parseInt(commandParts[2]);
            const scrollAmount = direction === 'down' ? pixels : -pixels;
            await page.evaluate((amount) => {
              // @ts-ignore - window is available in browser context
              window.scrollBy(0, amount);
            }, scrollAmount);
            logger.info(`Scrolled ${direction} ${pixels} pixels`);
          }
        }
        
      } else if (action === 'wait') {
        // Format: wait|milliseconds
        if (commandParts.length >= 2) {
          const ms = parseInt(commandParts[1]);
          await page.waitForTimeout(ms);
          logger.info(`Waited for ${ms}ms`);
        }
        
      } else if (action === 'waitfor') {
        // Format: waitfor|selector|timeout
        if (commandParts.length >= 2) {
          const selector = commandParts[1];
          const timeout = commandParts.length >= 3 ? parseInt(commandParts[2]) : 30000;
          await page.locator(selector).first().waitFor({ timeout });
          logger.info(`Element appeared: ${selector}`);
        }
        
      } else if (action === 'hover') {
        // Format: hover|selector
        if (commandParts.length >= 2) {
          const selector = commandParts[1];
          await page.locator(selector).first().hover();
          logger.info(`Hovered over: ${selector}`);
        }
        
      } else if (action === 'select') {
        // Format: select|selector|value
        if (commandParts.length >= 3) {
          const selector = commandParts[1];
          const value = commandParts.slice(2).join('|');
          await page.locator(selector).first().selectOption(value);
          logger.info(`Selected "${value}" in ${selector}`);
        }
        
      } else if (action === 'press') {
        // Format: press|key (e.g., press|Enter, press|Tab, press|Escape)
        if (commandParts.length >= 2) {
          const key = commandParts[1];
          await page.keyboard.press(key);
          logger.info(`Pressed key: ${key}`);
          
          // If Enter key was pressed, wait for potential navigation
          if (key === 'Enter') {
            try {
              await page.waitForLoadState('networkidle', { timeout: 5000 });
              logger.info('Page settled after Enter key press');
            } catch {
              // Page might not navigate, that's OK
            }
          }
        }
        
      } else if (action === 'back') {
        // Format: back
        await page.goBack({ waitUntil: 'networkidle' });
        logger.info('Navigated back');
        
      } else if (action === 'forward') {
        // Format: forward
        await page.goForward({ waitUntil: 'networkidle' });
        logger.info('Navigated forward');
        
      } else if (action === 'clear') {
        // Format: clear|selector
        if (commandParts.length >= 2) {
          const selector = commandParts[1];
          await page.locator(selector).first().clear();
          logger.info(`Cleared field: ${selector}`);
        }
        
      } else if (action === 'focus') {
        // Format: focus|selector
        if (commandParts.length >= 2) {
          const selector = commandParts[1];
          await page.locator(selector).first().focus();
          logger.info(`Focused on: ${selector}`);
        }
        
      } else if (action === 'screenshot') {
        // Format: screenshot() - No-op, screenshot is taken automatically after every command
        logger.info('Screenshot command (automatic screenshot will be captured)');
        
      } else if (action === 'capturedom') {
        // Format: captureDOM() - No-op, DOM is captured automatically after every command
        logger.info('CaptureDOM command (automatic DOM capture will be performed)');
        
      } else {
        logger.warn(`Unknown command action: ${action}`);
        throw new Error(`Unknown command action: ${action}`);
      }
      
      // Wait based on command settings
      if (command.wait_for === 'navigation') {
        await page.waitForLoadState('networkidle');
      } else if (command.wait_for === 'element') {
        // TODO: Implement element waiting
      }
      
      // Always wait for the page to settle before taking screenshot
      // This ensures we capture the page after JavaScript has finished executing
      try {
        // Wait for network to be idle (no requests for 500ms)
        await page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch (timeoutError) {
        // If networkidle times out, at least wait for DOM to be ready
        logger.warn('Network idle timeout, waiting for DOM content loaded');
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
      }
      
      // Additional wait for dynamic content to render
      await page.waitForTimeout(500);
      
      // Take screenshot
      const screenshotPath = path.join(this.screenshotDir, `${command.id}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      
      // Upload screenshot using Edge Function
      const screenshotBuffer = await fs.readFile(screenshotPath);
      const screenshotFileName = `${this.realtimeAuth.getUserId()}/${command.session_id}/${command.id}-screenshot.png`;
      
      logger.info(`Uploading screenshot: ${screenshotFileName} (${screenshotBuffer.length} bytes)`);
      
      try {
        const config = this.realtimeAuth.getConfig();
        const supabaseUrl = 'https://zqlfxakbkwssxfynrmnk.supabase.co';
        
        logger.debug(`Calling upload Edge Function for screenshot`, {
          fileName: screenshotFileName,
          size: screenshotBuffer.length,
          apiKey: config.supastate?.apiKey?.substring(0, 8)
        });
        
        const response = await fetch(`${supabaseUrl}/functions/v1/upload-browser-screenshot`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Supastate-Auth': config.supastate?.apiKey || ''
          },
          body: JSON.stringify({
            fileName: screenshotFileName,
            fileData: screenshotBuffer.toString('base64'),
            contentType: 'image/png'
          })
        });
        
        logger.info(`Screenshot upload response: ${response.status} ${response.statusText}`);
        
        if (response.ok) {
          const result = await response.json() as { success: boolean, path: string, url: string };
          screenshotUrl = result.url;
          logger.info(`Screenshot uploaded successfully: ${screenshotUrl}`);
        } else {
          const errorText = await response.text();
          logger.error(`Failed to upload screenshot via Edge Function: Status=${response.status}, Error=${errorText}`);
          // Fall back to base64
          screenshotUrl = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;
          logger.warn(`Falling back to base64 encoding for screenshot`);
        }
      } catch (error) {
        logger.error(`Failed to upload screenshot: ${error}`, { error });
        // Fall back to base64
        screenshotUrl = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;
        logger.warn(`Falling back to base64 encoding for screenshot due to error`);
      }
      
      // Capture DOM snapshot - Playwright doesn't have a built-in DOM tree serializer
      // but we can get the fully rendered HTML after JS execution
      // For now, let's capture both the HTML and key form elements
      const htmlContent = await page.content();
      
      // Capture ALL interactable elements with better selector information
      // The function passed to evaluate runs in the browser context
      const interactableElements = await page.evaluate(() => {
        const elements: any[] = [];
        // @ts-ignore - document is available in browser context
        if (typeof document === 'undefined') return elements;
        
        // Query for all potentially interactable elements
        const selectors = [
          'a[href]',
          'button',
          'input',
          'textarea',
          'select',
          '[role="button"]',
          '[role="link"]',
          '[onclick]',
          '[tabindex]:not([tabindex="-1"])',
          '.search-with-dialog', // GitHub specific
          '[data-action]', // GitHub uses data-action
          '[aria-label*="search" i]',
          '[placeholder*="search" i]'
        ];
        
        // @ts-ignore - document is available in browser context
        const allElements = document.querySelectorAll(selectors.join(', '));
        
        allElements.forEach((el: any) => {
          // Check if element is visible
          const rect = el.getBoundingClientRect();
          // @ts-ignore - window is available in browser context
          const isVisible = rect.width > 0 && rect.height > 0 && 
                          // @ts-ignore
                          window.getComputedStyle(el).display !== 'none' &&
                          // @ts-ignore
                          window.getComputedStyle(el).visibility !== 'hidden';
          
          if (!isVisible) return;
          
          // Generate the best selector for this element
          let selector = '';
          if (el.id) {
            selector = `#${el.id}`;
          } else if (el.className && typeof el.className === 'string') {
            const classes = el.className.trim().split(/\s+/).filter((c: string) => c && !c.includes(':'));
            if (classes.length > 0) {
              selector = `.${classes[0]}`;
            }
          } else if (el.getAttribute('aria-label')) {
            selector = `[aria-label="${el.getAttribute('aria-label')}"]`;
          } else if (el.getAttribute('placeholder')) {
            selector = `[placeholder="${el.getAttribute('placeholder')}"]`;
          } else if (el.tagName.toLowerCase() === 'button' && el.textContent) {
            selector = `button:has-text("${el.textContent.trim().substring(0, 20)}")`;
          } else {
            selector = el.tagName.toLowerCase();
          }
          
          elements.push({
            selector: selector,
            tagName: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.name || null,
            id: el.id || null,
            className: el.className || null,
            placeholder: el.placeholder || null,
            value: el.value || null,
            textContent: el.textContent?.trim()?.substring(0, 100) || null,
            ariaLabel: el.getAttribute('aria-label') || null,
            title: el.title || null,
            href: el.href || null,
            role: el.getAttribute('role') || null,
            dataAction: el.getAttribute('data-action') || null,
            isVisible: true,
            position: {
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height
            }
          });
        });
        
        // Sort by position (top to bottom, left to right)
        elements.sort((a, b) => {
          if (Math.abs(a.position.top - b.position.top) < 10) {
            return a.position.left - b.position.left;
          }
          return a.position.top - b.position.top;
        });
        
        return elements;
      });
      
      domSnapshot = {
        html: htmlContent,
        interactableElements: interactableElements,
        url: page.url()
      };
      
      // Upload DOM snapshot using Edge Function (as JSON now)
      domFileName = `${this.realtimeAuth.getUserId()}/${command.session_id}/${command.id}-dom.json`;
      
      const domData = JSON.stringify(domSnapshot);
      logger.info(`Uploading DOM snapshot: ${domFileName} (${domData.length} chars)`);
      
      try {
        const config = this.realtimeAuth.getConfig();
        const supabaseUrl = 'https://zqlfxakbkwssxfynrmnk.supabase.co';
        
        logger.debug(`Calling upload Edge Function for DOM`, {
          fileName: domFileName,
          size: domData.length,
          apiKey: config.supastate?.apiKey?.substring(0, 8)
        });
        
        const response = await fetch(`${supabaseUrl}/functions/v1/upload-browser-screenshot`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Supastate-Auth': config.supastate?.apiKey || ''
          },
          body: JSON.stringify({
            fileName: domFileName,
            fileData: Buffer.from(domData).toString('base64'),
            contentType: 'application/json'
          })
        });
        
        logger.info(`DOM upload response: ${response.status} ${response.statusText}`);
        
        if (response.ok) {
          const result = await response.json() as { success: boolean, path: string, url: string };
          logger.info(`DOM uploaded successfully: ${result.url}`);
        } else {
          const errorText = await response.text();
          logger.error(`Failed to upload DOM snapshot via Edge Function: Status=${response.status}, Error=${errorText}`);
          domFileName = null; // Clear if upload failed
        }
      } catch (error) {
        logger.error(`Failed to upload DOM snapshot: ${error}`, { error });
        domFileName = null; // Clear if upload failed
      }
      
      success = true;
      
      // Verify screenshot is accessible before proceeding (to avoid race conditions)
      if (screenshotUrl && !screenshotUrl.startsWith('data:')) {
        try {
          logger.info(`Verifying screenshot is accessible at: ${screenshotUrl}`);
          const verifyResponse = await fetch(screenshotUrl, { method: 'HEAD' });
          if (!verifyResponse.ok) {
            logger.warn(`Screenshot not yet accessible (${verifyResponse.status}), waiting...`);
            // Wait a bit for CDN propagation
            await new Promise(resolve => setTimeout(resolve, 1000));
            // Try once more
            const retryResponse = await fetch(screenshotUrl, { method: 'HEAD' });
            if (!retryResponse.ok) {
              logger.error(`Screenshot still not accessible after retry: ${retryResponse.status}`);
            }
          }
        } catch (error) {
          logger.warn(`Could not verify screenshot accessibility: ${error}`);
        }
      }
      
      // Update command status using Edge Function
      await this.updateCommandStatus(command.id, 'completed');
      
      // Update session's updated_at to keep it active
      await this.supabase!
        .from('browser_sessions')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', command.session_id);
    } catch (err) {
      // Provide detailed error information for the API to understand what went wrong
      if (err instanceof Error) {
        error = err.message;
        
        // Add more context based on error type
        if (err.message.includes('No element found matching selector')) {
          error = `Element not found: ${err.message}`;
        } else if (err.message.includes('Timeout')) {
          error = `Timeout: ${err.message}`;
        } else if (err.message.includes('Target page closed')) {
          error = 'Page closed unexpectedly';
        } else if (err.message.includes('Unknown command action')) {
          error = `Invalid command: ${err.message}`;
        }
      } else {
        error = 'Unknown error';
      }
      
      logger.error(`Command ${command.id} failed:`, err);
      
      // Update command status using Edge Function
      await this.updateCommandStatus(command.id, 'failed');
    }
    
    // Get current page URL and title from session
    const currentUrl = session?.page ? session.page.url() : null;
    const pageTitle = session?.page ? await session.page.title() : null;
    
    // Write result using Edge Function (since JWT might be expired)
    const result: BrowserResult = {
      command_id: command.id,
      session_id: command.session_id,
      success,
      screenshot_url: screenshotUrl,
      dom_snapshot: domFileName ? `storage://browser-automation/${domFileName}` : null, // Store reference to storage
      console_logs: consoleLogs,
      visual_diff: null, // TODO: Implement visual diff
      error,
      execution_time: Date.now() - startTime,
      current_url: currentUrl,
      page_title: pageTitle
    };
    
    // Use Edge Function to write result with API key auth
    try {
      const config = this.realtimeAuth.getConfig();
      const supabaseUrl = 'https://zqlfxakbkwssxfynrmnk.supabase.co';
      
      const response = await fetch(`${supabaseUrl}/functions/v1/write-browser-result`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Supastate-Auth': config.supastate?.apiKey || ''
        },
        body: JSON.stringify(result)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Failed to write result for command ${command.id}:`, errorText);
      } else {
        logger.info(`Successfully wrote result for command ${command.id} with screenshot: ${screenshotUrl ? 'yes' : 'no'}`);
        // Small delay to ensure database commit completes before real-time notification
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      logger.error(`Failed to write result for command ${command.id}:`, error);
    }
  }
  
  async stop() {
    this.isShuttingDown = true;
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    
    // Clean up SSE connection
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = undefined;
    }
    
    if (this.sseReconnectTimeout) {
      clearTimeout(this.sseReconnectTimeout);
      this.sseReconnectTimeout = undefined;
    }
    
    // Close all active browser sessions
    for (const [sessionId, session] of this.activeSessions) {
      try {
        await session.context.close();
      } catch (error) {
        logger.error(`Failed to close browser context for session ${sessionId}:`, error);
      }
    }
    this.activeSessions.clear();
    
    // Close browser
    if (this.browser) {
      await this.browser.close();
    }
    
    // Mark machine as inactive
    if (this.supabase) {
      await this.supabase
        .from('browser_machines')
        .update({ is_active: false })
        .eq('machine_id', this.machineId);
      
      // Close any active sessions
      await this.supabase
        .from('browser_sessions')
        .update({ 
          status: 'closed',
          closed_at: new Date().toISOString()
        })
        .eq('machine_id', this.machineId)
        .eq('status', 'active');
    }
    
    await this.realtimeAuth.disconnect();
    
    logger.info('Browser service stopped');
  }
}