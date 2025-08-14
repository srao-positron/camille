// Basic Supabase database types for browser automation
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      browser_machines: {
        Row: {
          id: string
          machine_id: string
          machine_name: string
          platform: string
          last_heartbeat: string
          is_active: boolean
          capabilities: Json
          user_id: string
          workspace_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          machine_id: string
          machine_name: string
          platform: string
          last_heartbeat?: string
          is_active?: boolean
          capabilities?: Json
          user_id: string
          workspace_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          machine_id?: string
          machine_name?: string
          platform?: string
          last_heartbeat?: string
          is_active?: boolean
          capabilities?: Json
          user_id?: string
          workspace_id?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      browser_sessions: {
        Row: {
          id: string
          machine_id: string
          browser: string
          status: string
          url: string
          viewport: Json
          cookies: Json | null
          created_at: string
          closed_at: string | null
          user_id: string
          workspace_id: string | null
        }
        Insert: {
          id?: string
          machine_id: string
          browser?: string
          status?: string
          url: string
          viewport?: Json
          created_at?: string
          closed_at?: string | null
          user_id: string
          workspace_id?: string | null
        }
        Update: {
          id?: string
          machine_id?: string
          browser?: string
          status?: string
          url?: string
          viewport?: Json
          created_at?: string
          closed_at?: string | null
          user_id?: string
          workspace_id?: string | null
        }
      }
      browser_commands: {
        Row: {
          id: string
          session_id: string
          machine_id: string
          command: string
          wait_for: string | null
          timeout: number
          credentials: Json | null
          status: string
          created_at: string
          processed_at: string | null
          user_id: string
          workspace_id: string | null
        }
        Insert: {
          id?: string
          session_id: string
          machine_id: string
          command: string
          wait_for?: string | null
          timeout?: number
          credentials?: Json | null
          status?: string
          created_at?: string
          processed_at?: string | null
          user_id: string
          workspace_id?: string | null
        }
        Update: {
          id?: string
          session_id?: string
          machine_id?: string
          command?: string
          wait_for?: string | null
          timeout?: number
          credentials?: Json | null
          status?: string
          created_at?: string
          processed_at?: string | null
          user_id?: string
          workspace_id?: string | null
        }
      }
      browser_results: {
        Row: {
          id: string
          command_id: string
          session_id: string
          success: boolean
          screenshot_url: string | null
          dom_snapshot: Json | null
          console_logs: Json | null
          visual_diff: Json | null
          error: string | null
          execution_time: number
          current_url: string | null
          page_title: string | null
          created_at: string
        }
        Insert: {
          id?: string
          command_id: string
          session_id: string
          success: boolean
          screenshot_url?: string | null
          dom_snapshot?: Json | null
          console_logs?: Json | null
          visual_diff?: Json | null
          error?: string | null
          execution_time: number
          current_url?: string | null
          page_title?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          command_id?: string
          session_id?: string
          success?: boolean
          screenshot_url?: string | null
          dom_snapshot?: Json | null
          console_logs?: Json | null
          visual_diff?: Json | null
          error?: string | null
          execution_time?: number
          created_at?: string
        }
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      update_browser_machine_heartbeat: {
        Args: {
          p_machine_id: string
          p_capabilities: Json
        }
        Returns: void
      }
      cleanup_stale_browser_machines: {
        Args: Record<PropertyKey, never>
        Returns: void
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}