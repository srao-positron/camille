/**
 * Type declarations for Kuzu database
 */

declare module 'kuzu' {
  export class Database {
    constructor(path: string);
    connect(): Connection;
  }

  export class Connection {
    constructor(database: Database);
    execute(query: string, parameters?: Record<string, any>): Promise<QueryResult>;
    beginTransaction(): Promise<Transaction>;
  }

  export class Transaction {
    execute(query: string, parameters?: Record<string, any>): Promise<QueryResult>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
  }

  export interface QueryResult {
    getRecords(): any[];
    getAllObjects(): Promise<any[]>;
    getAll(): Promise<any[]>;
  }
}