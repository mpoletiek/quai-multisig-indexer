import { quais, Shard, FetchRequest } from 'quais';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

// Default shard based on RPC URL (cyprus1)
const DEFAULT_SHARD = Shard.Cyprus1;

class QuaiService {
  private provider: quais.JsonRpcProvider;
  private wsProvider: quais.WebSocketProvider | null = null;
  private shard: Shard;
  private rpcUrl: string;

  constructor(shard: Shard = DEFAULT_SHARD) {
    this.shard = shard;
    this.rpcUrl = config.quai.rpcUrl;
    // Create provider with colosseum network to skip network detection
    const network = new quais.Network('colosseum', 9000);
    this.provider = new quais.JsonRpcProvider(this.rpcUrl, network, {
      usePathing: true,
    });
  }

  async getBlockNumber(): Promise<number> {
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
