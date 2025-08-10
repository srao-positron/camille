import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { logger } from '../logger.js';
import { ConfigManager } from '../config.js';

export class BrowserRealtimeAuth {
  private supabase?: SupabaseClient;
  private token?: string;
  private tokenExpiry?: Date;
  private refreshTimer?: NodeJS.Timeout;
  private channel?: RealtimeChannel;
  private config: ConfigManager;
  private userId?: string;
  private machineId: string;

  constructor(machineId: string) {
    this.config = new ConfigManager();
    this.machineId = machineId;
  }

  async initialize(): Promise<void> {
    const supastate = this.config.getConfig().supastate;
    
    if (!supastate?.url || !supastate?.apiKey) {
      throw new Error('Supastate not configured. Run "camille supastate login" first.');
    }

    // Exchange API key for JWT
    await this.refreshToken();
    
    // Create Supabase client with JWT
    // Use the correct Supabase URL
    const supabaseUrl = 'https://zqlfxakbkwssxfynrmnk.supabase.co';
    const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpxbGZ4YWtia3dzc3hmeW5ybW5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTMxMjQzMTIsImV4cCI6MjA2ODcwMDMxMn0.qHj1WTuVlhS9Tq63ZNFtSGxDBU8w06Lci6pgTzV5-go';
    
    logger.info(`Creating Supabase client with URL: ${supabaseUrl}`);
    logger.info(`Using JWT token for user: ${this.userId}`);
    
    // Create client with anon key but use JWT for auth
    this.supabase = createClient(supabaseUrl, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
      },
      global: {
        headers: {
          Authorization: `Bearer ${this.token}`
        }
      }
    });
    
    // Set the access token directly for Realtime
    await this.supabase.auth.setSession({
      access_token: this.token!,
      refresh_token: '', // We don't have a refresh token
    });
    
    // Test the connection
    try {
      const { data, error } = await this.supabase
        .from('browser_machines')
        .select('machine_id')
        .limit(1);
      
      if (error) {
        logger.error('Failed to test Supabase connection:', error);
      } else {
        logger.info('Supabase connection test successful, found machines:', data?.length || 0);
      }
    } catch (err) {
      logger.error('Exception testing Supabase connection:', err);
    }
  }

  private async refreshToken(): Promise<void> {
    const supastate = this.config.getConfig().supastate;
    if (!supastate?.url || !supastate?.apiKey) {
      throw new Error('Supastate configuration missing');
    }

    try {
      // Call the edge function to exchange API key for JWT
      const supabaseUrl = 'https://zqlfxakbkwssxfynrmnk.supabase.co';
      const response = await fetch(`${supabaseUrl}/functions/v1/exchange-api-key`, {
        method: 'POST',
        headers: {
          'X-Supastate-Auth': supastate.apiKey
        }
      });

      if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.statusText}`);
      }

      const data = await response.json() as { token: string; userId: string; expiresIn: number };
      
      this.token = data.token;
      this.userId = data.userId;
      this.tokenExpiry = new Date(Date.now() + (data.expiresIn * 1000));
      
      logger.info(`Realtime token obtained, expires at ${this.tokenExpiry.toISOString()}`);
      
      // Schedule refresh 5 minutes before expiry
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
      }
      
      const refreshIn = (data.expiresIn - 300) * 1000; // 5 min before expiry
      this.refreshTimer = setTimeout(() => {
        this.refreshToken();
      }, refreshIn);
      
      // If we already have a Supabase client, recreate it with new token
      if (this.supabase) {
        const anonKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpxbGZ4YWtia3dzc3hmeW5ybW5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTMxMjQzMTIsImV4cCI6MjA2ODcwMDMxMn0.qHj1WTuVlhS9Tq63ZNFtSGxDBU8w06Lci6pgTzV5-go';
        this.supabase = createClient(supabaseUrl, anonKey, {
          auth: {
            autoRefreshToken: false,
            persistSession: false
          },
          global: {
            headers: {
              Authorization: `Bearer ${this.token}`
            }
          }
        });
        
        // Resubscribe to channels
        if (this.channel) {
          await this.subscribeToCommands();
        }
      }
    } catch (error) {
      logger.error('Failed to refresh Realtime token:', error);
      throw error;
    }
  }

  async subscribeToCommands(): Promise<RealtimeChannel> {
    if (!this.supabase || !this.userId) {
      throw new Error('Not initialized');
    }

    // Unsubscribe from existing channel
    if (this.channel) {
      await this.supabase.removeChannel(this.channel);
    }

    // Create channel with access_token for auth
    this.channel = this.supabase
      .channel(`browser_commands:${this.userId}`, {
        config: {
          broadcast: { self: true },
          presence: { key: this.machineId },
          private: false
        }
      })
      .subscribe((status, err) => {
        logger.info(`Realtime subscription status: ${status}`, err ? { error: err } : {});
        if (status === 'SUBSCRIBED') {
          logger.info(`Successfully subscribed to browser commands for user ${this.userId}`);
        } else if (status === 'CHANNEL_ERROR') {
          logger.error('Failed to subscribe to browser commands channel', err);
        } else if (status === 'TIMED_OUT') {
          logger.error('Subscription timed out');
        }
      });

    return this.channel;
  }

  getSupabase(): SupabaseClient {
    if (!this.supabase) {
      throw new Error('Not initialized');
    }
    return this.supabase;
  }

  getUserId(): string | undefined {
    return this.userId;
  }
  
  getConfig() {
    return this.config.getConfig();
  }

  async disconnect(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    
    if (this.channel && this.supabase) {
      await this.supabase.removeChannel(this.channel);
    }
  }
}