/**
 * REST API server for Camille
 * Provides HTTP endpoints to query the graph database and other services
 */

import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';
import { logger } from './logger.js';
import { ServerManager } from './server.js';
import { KuzuGraphDB } from './memory/databases/kuzu-db.js';

export class CamilleAPIServer {
  private app: express.Application;
  private server?: http.Server;
  private port: number;
  private graphDB?: KuzuGraphDB;

  constructor(port: number = 3456) {
    this.port = port;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // JSON body parsing
    this.app.use(express.json());
    
    // CORS for local development
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      next();
    });

    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      logger.info('API Request', {
        method: req.method,
        path: req.path,
        query: req.query,
        body: req.method === 'POST' ? req.body : undefined
      });
      next();
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/api/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Server status
    this.app.get('/api/status', async (req: Request, res: Response) => {
      try {
        const server = ServerManager.getInstance();
        if (!server) {
          res.status(503).json({ error: 'Server not running' });
          return;
        }

        const status = server.getStatus();
        const embeddings = server.getEmbeddingsIndex();
        
        res.json({
          running: status.isRunning,
          indexReady: embeddings.isIndexReady(),
          indexing: status.isIndexing,
          filesIndexed: status.indexSize,
          queueSize: status.queueSize,
          graphIndexing: status.graphIndexing || {
            nodeCount: 0,
            edgeCount: 0,
            inProgress: false
          }
        });
      } catch (error) {
        logger.error('API status error', { error });
        res.status(500).json({ error: 'Failed to get status' });
      }
    });

    // Graph query endpoint
    this.app.post('/api/graph/query', async (req: Request, res: Response) => {
      try {
        const { query, explain = false } = req.body;
        
        if (!query) {
          res.status(400).json({ error: 'Query parameter is required' });
          return;
        }

        // Get the graph database from the main server
        const server = ServerManager.getInstance();
        if (!server) {
          res.status(503).json({ error: 'Server not running' });
          return;
        }

        // Access the graph database through the server's public method
        const graphDB = server.getGraphDatabase();
        if (!graphDB || !graphDB.isReady()) {
          res.status(503).json({ error: 'Graph database not ready' });
          return;
        }

        // Execute the query
        const results = await graphDB.query(query);
        
        res.json({
          query,
          resultCount: results.length,
          results,
          statistics: {
            nodeCount: await graphDB.getNodeCount(),
            edgeCount: await graphDB.getEdgeCount()
          }
        });
      } catch (error) {
        logger.error('Graph query error', { error });
        res.status(500).json({ 
          error: 'Query failed', 
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Graph statistics
    this.app.get('/api/graph/stats', async (req: Request, res: Response) => {
      try {
        const server = ServerManager.getInstance();
        if (!server) {
          res.status(503).json({ error: 'Server not running' });
          return;
        }

        const graphDB = server.getGraphDatabase();
        if (!graphDB || !graphDB.isReady()) {
          res.status(503).json({ error: 'Graph database not ready' });
          return;
        }

        const [nodeCount, edgeCount] = await Promise.all([
          graphDB.getNodeCount(),
          graphDB.getEdgeCount()
        ]);

        // Get node type distribution
        const nodeTypes = await graphDB.query(
          "MATCH (n:CodeObject) RETURN n.type as type, COUNT(n) as count ORDER BY count DESC"
        );

        // Get edge type distribution
        const edgeTypes = await graphDB.query(
          "MATCH ()-[r]->() RETURN type(r) as type, COUNT(r) as count ORDER BY count DESC"
        );

        res.json({
          nodeCount,
          edgeCount,
          nodeTypes,
          edgeTypes,
          ready: graphDB.isReady()
        });
      } catch (error) {
        logger.error('Graph stats error', { error });
        res.status(500).json({ error: 'Failed to get graph statistics' });
      }
    });

    // Trigger edge re-indexing
    this.app.post('/api/reindex-edges', async (req: Request, res: Response) => {
      try {
        const server = ServerManager.getInstance();
        if (!server) {
          res.status(503).json({ error: 'Server not running' });
          return;
        }

        logger.info('API: Triggering edge re-indexing');
        
        // Run the re-indexing in the background
        server.triggerSecondPass().then(() => {
          logger.info('API: Edge re-indexing completed');
        }).catch((error) => {
          logger.error('API: Edge re-indexing failed', { error });
        });

        res.json({ 
          message: 'Edge re-indexing started',
          status: 'processing'
        });
      } catch (error) {
        logger.error('Edge reindex error', { error });
        res.status(500).json({ error: 'Failed to start edge re-indexing' });
      }
    });

    // Search endpoint (delegates to main server's search)
    this.app.post('/api/search', async (req: Request, res: Response) => {
      try {
        const { query, limit = 10, includeDependencies = true } = req.body;
        
        if (!query) {
          res.status(400).json({ error: 'Query parameter is required' });
          return;
        }

        const server = ServerManager.getInstance();
        if (!server) {
          res.status(503).json({ error: 'Server not running' });
          return;
        }

        const unifiedSearch = server.getUnifiedSearch();
        if (!unifiedSearch) {
          res.status(503).json({ error: 'Search service not ready' });
          return;
        }
        
        const results = await unifiedSearch.search(query, { limit, includeDependencies });
        res.json(results);
      } catch (error) {
        logger.error('Search error', { error });
        res.status(500).json({ error: 'Search failed' });
      }
    });

    // 404 handler
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Error handler
    this.app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
      logger.error('API error', { error: err });
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, () => {
          logger.info('API server started', { port: this.port });
          console.log(`✅ REST API server listening on http://localhost:${this.port}`);
          console.log('Available endpoints:');
          console.log(`  GET  http://localhost:${this.port}/api/health`);
          console.log(`  GET  http://localhost:${this.port}/api/status`);
          console.log(`  GET  http://localhost:${this.port}/api/graph/stats`);
          console.log(`  POST http://localhost:${this.port}/api/graph/query`);
          console.log(`  POST http://localhost:${this.port}/api/search`);
          resolve();
        });

        this.server.on('error', (error: Error) => {
          logger.error('API server error', { error });
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server?.close(() => {
          logger.info('API server stopped');
          resolve();
        });
      });
    }
  }
}