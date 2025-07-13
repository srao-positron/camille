# Peer-to-Peer Memory Sharing Design Document

## Overview

The peer-to-peer system enables secure, decentralized sharing of memory banks (transcripts and code indices) between team members, with automatic discovery via mDNS/Bonjour and RESTful API communication.

## Architecture

### Network Stack

```
┌─────────────────────────────────────────────────────┐
│                   Application Layer                  │
├─────────────────────────────────────────────────────┤
│  REST API (HTTPS)  │  mDNS Discovery  │  WebSocket │
├─────────────────────────────────────────────────────┤
│         Express.js with Self-Signed Certs           │
├─────────────────────────────────────────────────────┤
│              Node.js Network Layer                   │
└─────────────────────────────────────────────────────┘
```

## Service Discovery

### mDNS/Bonjour Implementation

```typescript
import * as bonjour from 'bonjour';
import * as crypto from 'crypto';

interface PeerService {
  name: string;
  host: string;
  port: number;
  txt: {
    version: string;
    pubkey: string;
    capabilities: string[];
    indirect: boolean;
  };
}

class PeerDiscovery {
  private mdns = bonjour();
  private service?: bonjour.Service;
  
  async startAdvertising(config: PeerConfig): Promise<void> {
    const hostname = os.hostname();
    const pubkey = await this.getPublicKey();
    
    this.service = this.mdns.publish({
      name: `camille-${hostname}-${config.userId}`,
      type: 'camille-memory',
      port: config.port,
      txt: {
        version: PROTOCOL_VERSION,
        pubkey: pubkey,
        capabilities: ['search', 'graph', 'transcript'],
        indirect: config.allowIndirect
      }
    });
    
    logger.info('Started mDNS advertising', { 
      name: this.service.name,
      port: config.port 
    });
  }
  
  async discoverPeers(timeout: number = 5000): Promise<PeerService[]> {
    return new Promise((resolve) => {
      const peers: PeerService[] = [];
      const browser = this.mdns.find({ type: 'camille-memory' });
      
      browser.on('up', (service: bonjour.Service) => {
        if (this.isValidPeer(service)) {
          peers.push({
            name: service.name,
            host: service.host,
            port: service.port,
            txt: service.txt as any
          });
          
          logger.info('Discovered peer', { 
            name: service.name,
            host: service.host 
          });
        }
      });
      
      setTimeout(() => {
        browser.stop();
        resolve(peers);
      }, timeout);
    });
  }
  
  private isValidPeer(service: bonjour.Service): boolean {
    // Validate service has required fields
    return !!(
      service.txt?.version &&
      service.txt?.pubkey &&
      service.txt?.capabilities &&
      service.port &&
      service.host
    );
  }
}
```

## REST API Design

### API Endpoints

```typescript
// API Routes
router.get('/api/v1/search', authenticate, rateLimit, searchHandler);
router.get('/api/v1/status', statusHandler);
router.get('/api/v1/info', infoHandler);
router.get('/api/v1/peers', authenticate, peersHandler);
router.post('/api/v1/forward', authenticate, forwardHandler);

// OpenAPI Schema
const apiSchema = {
  openapi: '3.0.0',
  info: {
    title: 'Camille P2P Memory API',
    version: '1.0.0'
  },
  paths: {
    '/api/v1/search': {
      get: {
        summary: 'Search memory bank',
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'Search query'
          },
          {
            name: 'type',
            in: 'query',
            schema: { 
              type: 'string',
              enum: ['transcript', 'code', 'all']
            }
          },
          {
            name: 'limit',
            in: 'query',
            schema: { 
              type: 'integer',
              default: 10,
              maximum: 100
            }
          },
          {
            name: 'request_chain',
            in: 'header',
            schema: {
              type: 'array',
              items: { type: 'string' }
            },
            description: 'Chain of peer IDs to prevent loops'
          }
        ],
        security: [{ apiKey: [] }]
      }
    }
  }
};
```

### Authentication

```typescript
interface ApiKey {
  id: string;
  key: string;  // hashed
  name: string;
  created: Date;
  lastUsed?: Date;
  permissions: Permission[];
}

class ApiKeyManager {
  async generateApiKey(name: string): Promise<string> {
    const key = crypto.randomBytes(32).toString('base64url');
    const hashedKey = await this.hashKey(key);
    
    await this.db.insert('api_keys', {
      id: crypto.randomUUID(),
      key: hashedKey,
      name: name,
      created: new Date(),
      permissions: ['read']  // Read-only by default
    });
    
    // Return the unhashed key (only shown once)
    return key;
  }
  
  async validateApiKey(key: string): Promise<ApiKey | null> {
    const hashedKey = await this.hashKey(key);
    const apiKey = await this.db.findOne('api_keys', { key: hashedKey });
    
    if (apiKey) {
      // Update last used
      await this.db.update('api_keys', apiKey.id, { 
        lastUsed: new Date() 
      });
    }
    
    return apiKey;
  }
  
  private async hashKey(key: string): Promise<string> {
    return crypto
      .createHash('sha256')
      .update(key + SALT)
      .digest('hex');
  }
}

// Express middleware
const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'] as string;
  
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }
  
  const validKey = await apiKeyManager.validateApiKey(apiKey);
  if (!validKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  
  req.apiKey = validKey;
  next();
};
```

### HTTPS with Self-Signed Certificates

```typescript
import * as https from 'https';
import * as forge from 'node-forge';

class CertificateManager {
  private certPath = path.join(os.homedir(), '.camille/certs');
  
  async ensureCertificates(): Promise<{ key: string; cert: string }> {
    const keyPath = path.join(this.certPath, 'server.key');
    const certPath = path.join(this.certPath, 'server.crt');
    
    if (await this.certificatesExist()) {
      return {
        key: await fs.readFile(keyPath, 'utf8'),
        cert: await fs.readFile(certPath, 'utf8')
      };
    }
    
    // Generate self-signed certificate
    return this.generateSelfSignedCert();
  }
  
  private async generateSelfSignedCert(): Promise<{ key: string; cert: string }> {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(
      cert.validity.notBefore.getFullYear() + 10
    );
    
    const attrs = [{
      name: 'commonName',
      value: 'camille.local'
    }, {
      name: 'organizationName',
      value: 'Camille Memory System'
    }];
    
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{
      name: 'subjectAltName',
      altNames: [{
        type: 2, // DNS
        value: 'localhost'
      }, {
        type: 7, // IP
        ip: '127.0.0.1'
      }]
    }]);
    
    cert.sign(keys.privateKey, forge.md.sha256.create());
    
    const pem = {
      key: forge.pki.privateKeyToPem(keys.privateKey),
      cert: forge.pki.certificateToPem(cert)
    };
    
    // Save certificates
    await fs.mkdir(this.certPath, { recursive: true });
    await fs.writeFile(path.join(this.certPath, 'server.key'), pem.key);
    await fs.writeFile(path.join(this.certPath, 'server.crt'), pem.cert);
    
    return pem;
  }
}

// Create HTTPS server
const createPeerServer = async (app: Express): Promise<https.Server> => {
  const certManager = new CertificateManager();
  const { key, cert } = await certManager.ensureCertificates();
  
  return https.createServer({ key, cert }, app);
};
```

## Request Forwarding and Loop Detection

```typescript
interface ForwardRequest {
  originalQuery: SearchRequest;
  requestChain: string[];
  ttl: number;  // Time to live (hop count)
}

class RequestForwarder {
  private readonly MAX_TTL = 3;
  private readonly peerId = crypto.randomUUID();
  
  async forwardSearch(
    query: SearchRequest,
    fromPeer?: string
  ): Promise<AggregatedResults> {
    // Initialize request chain if not present
    const requestChain = query.request_chain || [];
    
    // Add ourselves to the chain
    if (!requestChain.includes(this.peerId)) {
      requestChain.push(this.peerId);
    }
    
    // Check TTL
    if (requestChain.length >= this.MAX_TTL) {
      logger.warn('Request TTL exceeded', { chain: requestChain });
      return { results: [], error: 'TTL exceeded' };
    }
    
    // Get peers to forward to
    const peers = await this.getForwardingPeers(requestChain, fromPeer);
    
    // Forward requests in parallel
    const forwardPromises = peers.map(peer => 
      this.forwardToPeer(peer, {
        ...query,
        request_chain: requestChain
      }).catch(err => ({
        peer: peer.id,
        error: err.message,
        results: []
      }))
    );
    
    const responses = await Promise.all(forwardPromises);
    
    // Aggregate results
    return this.aggregateResponses(responses);
  }
  
  private async getForwardingPeers(
    requestChain: string[],
    excludePeer?: string
  ): Promise<Peer[]> {
    const allPeers = await this.peerManager.getActivePeers();
    
    return allPeers.filter(peer => {
      // Don't forward back to sender
      if (peer.id === excludePeer) return false;
      
      // Don't forward to peers already in chain
      if (requestChain.includes(peer.id)) return false;
      
      // Only forward to peers that allow indirect
      if (!peer.allowsIndirect) return false;
      
      return true;
    });
  }
  
  private async forwardToPeer(
    peer: Peer,
    query: SearchRequest
  ): Promise<PeerResponse> {
    try {
      const response = await axios.get(
        `https://${peer.host}:${peer.port}/api/v1/search`,
        {
          params: {
            q: query.q,
            type: query.type,
            limit: query.limit
          },
          headers: {
            'X-API-Key': peer.apiKey,
            'X-Request-Chain': JSON.stringify(query.request_chain),
            'X-Forwarded-By': this.peerId
          },
          httpsAgent: new https.Agent({
            rejectUnauthorized: false  // Accept self-signed certs
          }),
          timeout: 5000
        }
      );
      
      return {
        peer: peer.id,
        results: response.data.results,
        source: peer.name
      };
    } catch (error) {
      logger.error('Failed to forward to peer', { 
        peer: peer.id,
        error 
      });
      throw error;
    }
  }
}
```

## Rate Limiting

```typescript
import * as RateLimiter from 'express-rate-limit';

const createRateLimiter = () => {
  return RateLimiter({
    windowMs: 60 * 1000,  // 1 minute
    max: 60,              // 60 requests per minute
    message: 'Too many requests',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      // Rate limit by API key
      return req.apiKey?.id || req.ip;
    },
    handler: (req, res) => {
      logger.warn('Rate limit exceeded', {
        apiKey: req.apiKey?.id,
        ip: req.ip
      });
      
      res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: req.rateLimit.resetTime
      });
    }
  });
};

// Apply different limits to different endpoints
const searchRateLimit = createRateLimiter();
const statusRateLimit = RateLimiter({
  windowMs: 60 * 1000,
  max: 300  // Higher limit for status checks
});
```

## Peer Management UI

```typescript
interface PeerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  apiKey: string;
  discovered: boolean;  // via mDNS or manual
  allowIndirect: boolean;
  lastSeen?: Date;
  status: 'active' | 'inactive' | 'error';
}

class PeerManagerUI {
  async addPeerWizard(): Promise<void> {
    const { method } = await inquirer.prompt([{
      type: 'list',
      name: 'method',
      message: 'How would you like to add a peer?',
      choices: [
        { name: 'Discover nearby peers (Bonjour)', value: 'discover' },
        { name: 'Enter peer details manually', value: 'manual' }
      ]
    }]);
    
    if (method === 'discover') {
      await this.discoverPeers();
    } else {
      await this.addManualPeer();
    }
  }
  
  private async discoverPeers(): Promise<void> {
    const spinner = ora('Discovering peers...').start();
    const discovery = new PeerDiscovery();
    const peers = await discovery.discoverPeers(10000);
    spinner.stop();
    
    if (peers.length === 0) {
      console.log(chalk.yellow('No peers found on local network'));
      return;
    }
    
    const { selected } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'selected',
      message: 'Select peers to add:',
      choices: peers.map(peer => ({
        name: `${peer.name} (${peer.host}:${peer.port})`,
        value: peer
      }))
    }]);
    
    for (const peer of selected) {
      const { apiKey } = await inquirer.prompt([{
        type: 'password',
        name: 'apiKey',
        message: `Enter API key for ${peer.name}:`,
        mask: '*'
      }]);
      
      await this.savePeer({
        id: crypto.randomUUID(),
        name: peer.name,
        host: peer.host,
        port: peer.port,
        apiKey: apiKey,
        discovered: true,
        allowIndirect: peer.txt.indirect,
        status: 'active'
      });
    }
  }
}
```

## Result Aggregation

```typescript
interface SearchResult {
  id: string;
  score: number;
  content: string;
  metadata: any;
  source: string;  // 'local' or peer name
}

class ResultAggregator {
  aggregate(
    local: SearchResult[],
    peer: PeerResponse[],
    options: AggregationOptions
  ): SearchResult[] {
    if (options.merge) {
      return this.mergeResults(local, peer);
    } else {
      return this.groupResults(local, peer);
    }
  }
  
  private mergeResults(
    local: SearchResult[],
    peer: PeerResponse[]
  ): SearchResult[] {
    // Combine all results
    const all: SearchResult[] = [
      ...local.map(r => ({ ...r, source: 'local' })),
      ...peer.flatMap(p => 
        p.results.map(r => ({ 
          ...r, 
          source: `peer:${p.source}`,
          // Adjust score based on source distance
          score: r.score * this.getDistanceFactor(p)
        }))
      )
    ];
    
    // Sort by score (highest first)
    all.sort((a, b) => b.score - a.score);
    
    // Remove duplicates (same content from multiple sources)
    const seen = new Set<string>();
    return all.filter(result => {
      const key = this.getResultKey(result);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
  
  private getDistanceFactor(peer: PeerResponse): number {
    // Reduce score based on network distance
    if (peer.hops === 0) return 1.0;    // Direct peer
    if (peer.hops === 1) return 0.9;    // One hop
    if (peer.hops === 2) return 0.8;    // Two hops
    return 0.7;                          // Three+ hops
  }
}
```

## Audit Logging

```typescript
interface AuditLog {
  timestamp: Date;
  event: 'search' | 'forward' | 'access';
  apiKey: string;
  peerId?: string;
  query?: string;
  results?: number;
  duration?: number;
  error?: string;
}

class AuditLogger {
  private logPath = path.join(os.homedir(), '.camille/logs/peer_access.log');
  
  async log(entry: AuditLog): Promise<void> {
    const line = JSON.stringify({
      ...entry,
      timestamp: entry.timestamp.toISOString()
    }) + '\n';
    
    await fs.appendFile(this.logPath, line);
    
    // Also log to main logger
    logger.info('Peer access', entry);
  }
  
  async getRecentLogs(hours: number = 24): Promise<AuditLog[]> {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - hours);
    
    const content = await fs.readFile(this.logPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    
    return lines
      .map(line => JSON.parse(line))
      .filter(log => new Date(log.timestamp) > cutoff);
  }
}
```

## Security Considerations

1. **API Key Security**
   - Keys are hashed before storage
   - Keys shown only once during generation
   - Regular key rotation recommended

2. **Certificate Validation**
   - Self-signed certs accepted for peer connections
   - Certificate pinning for known peers
   - Optional CA-signed certs support

3. **Request Validation**
   - Input sanitization on all endpoints
   - Query size limits
   - Result size limits

4. **Access Control**
   - Read-only access for peer API keys
   - No remote write operations
   - Project-level access control

## Performance Optimization

1. **Connection Pooling**
   - Reuse HTTPS connections to peers
   - Connection timeout: 30 seconds
   - Max connections per peer: 5

2. **Response Caching**
   - Cache peer responses for 60 seconds
   - Cache key includes query + peer ID
   - LRU eviction policy

3. **Parallel Queries**
   - Query all peers concurrently
   - Timeout per peer: 5 seconds
   - Return partial results on timeout

## Integration Points

- [Implementation Plan](./implementation-plan.md): Overall architecture
- [PreCompact Hook Design](./precompact-hook-design.md): Data source
- [MCP Tools Design](./mcp-tools-design.md): Query interface
- [Graph Index Design](./graph-index-design.md): Code search integration