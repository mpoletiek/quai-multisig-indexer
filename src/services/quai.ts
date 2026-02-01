import { quais, FetchRequest } from 'quais';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

class QuaiService {
  private wsProvider: quais.WebSocketProvider | null = null;
  private rpcUrl: string;

  // Rate limiting state
  private requestTimestamps: number[] = [];

  // Block timestamp cache (LRU-style using Map insertion order)
  private timestampCache: Map<number, number> = new Map();

  constructor() {
    this.rpcUrl = config.quai.rpcUrl;
  }

  // Rate limiter: ensures we don't exceed RPC rate limits
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const windowMs = config.rateLimit.windowMs;
    const maxRequests = config.rateLimit.requestsPerWindow;

    // Remove timestamps outside the current window
    this.requestTimestamps = this.requestTimestamps.filter(
      (ts) => now - ts < windowMs
    );

    if (this.requestTimestamps.length >= maxRequests) {
      // Wait until the oldest request exits the window
      const waitTime = windowMs - (now - this.requestTimestamps[0]);
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    this.requestTimestamps.push(Date.now());
  }

  async getBlockNumber(): Promise<number> {
    await this.rateLimit();
    return withRetry(async () => {
      const req = new FetchRequest(this.rpcUrl);
      req.body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'quai_blockNumber',
        params: [],
        id: 1,
      });
      req.setHeader('Content-Type', 'application/json');
      const response = await req.send();
      const json = JSON.parse(response.bodyText);
      return parseInt(json.result, 16);
    });
  }

  async getLogs(
    address: string | string[],
    topics: (string | string[] | null)[],
    fromBlock: number,
    toBlock: number
  ): Promise<quais.Log[]> {
    await this.rateLimit();
    return withRetry(async () => {
      const req = new FetchRequest(this.rpcUrl);
      const params = {
        address,
        topics,
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
      };
      req.body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'quai_getLogs',
        params: [params],
        id: 1,
      });
      req.setHeader('Content-Type', 'application/json');
      const response = await req.send();
      const json = JSON.parse(response.bodyText);

      if (json.error) {
        throw new Error(`RPC Error: ${json.error.message || JSON.stringify(json.error)}`);
      }

      // Convert raw logs to quais.Log format
      return (json.result || []).map((log: Record<string, unknown>) => ({
        address: log.address as string,
        topics: log.topics as string[],
        data: log.data as string,
        blockNumber: parseInt(log.blockNumber as string, 16),
        transactionHash: log.transactionHash as string,
        transactionIndex: parseInt(log.transactionIndex as string, 16),
        blockHash: log.blockHash as string,
        index: parseInt(log.logIndex as string, 16),
        removed: log.removed as boolean,
      }));
    });
  }

  async callContract(address: string, functionSignature: string): Promise<string> {
    await this.rateLimit();
    return withRetry(async () => {
      const selector = quais.id(functionSignature).slice(0, 10);
      const req = new FetchRequest(this.rpcUrl);
      req.body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'quai_call',
        params: [{ to: address, data: selector }, 'latest'],
        id: 1,
      });
      req.setHeader('Content-Type', 'application/json');
      const response = await req.send();
      const json = JSON.parse(response.bodyText);

      if (json.error) {
        throw new Error(`RPC Error: ${json.error.message || JSON.stringify(json.error)}`);
      }

      return json.result;
    });
  }

  async getBlockTimestamp(blockNumber: number): Promise<number> {
    // Check cache first
    const cached = this.timestampCache.get(blockNumber);
    if (cached !== undefined) {
      return cached;
    }

    await this.rateLimit();
    const timestamp = await withRetry(async () => {
      const req = new FetchRequest(this.rpcUrl);
      req.body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'quai_getBlockByNumber',
        params: ['0x' + blockNumber.toString(16), false],
        id: 1,
      });
      req.setHeader('Content-Type', 'application/json');
      const response = await req.send();
      const json = JSON.parse(response.bodyText);

      if (json.error) {
        throw new Error(`RPC Error: ${json.error.message || JSON.stringify(json.error)}`);
      }

      // Quai blocks have timestamp in woHeader (work object header)
      const ts = json.result?.woHeader?.timestamp || json.result?.timestamp;
      if (!json.result || !ts) {
        throw new Error(`Block ${blockNumber} not found or missing timestamp`);
      }

      return parseInt(ts, 16);
    });

    // Cache the result (with LRU eviction)
    if (this.timestampCache.size >= config.cache.timestampCacheSize) {
      // Delete the oldest entry (first key in Map)
      const oldestKey = this.timestampCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.timestampCache.delete(oldestKey);
      }
    }
    this.timestampCache.set(blockNumber, timestamp);

    return timestamp;
  }

  async subscribeToEvents(
    addresses: string[],
    topics: string[],
    callback: (log: quais.Log) => void
  ): Promise<void> {
    if (!this.wsProvider) {
      this.wsProvider = new quais.WebSocketProvider(config.quai.wsUrl, undefined, {
        usePathing: true,
      });
    }

    const filter = {
      address: addresses,
      topics: [topics],
    };

    this.wsProvider.on(filter, callback);
    logger.info({ addresses: addresses.length, topics }, 'Subscribed to events');
  }

  async unsubscribe(): Promise<void> {
    if (this.wsProvider) {
      await this.wsProvider.destroy();
      this.wsProvider = null;
    }
  }
}

export const quai = new QuaiService();
