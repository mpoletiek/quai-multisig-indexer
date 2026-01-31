import { config } from './config.js';
import { quai } from './services/quai.js';
import { supabase } from './services/supabase.js';
import {
  decodeEvent,
  getAllEventTopics,
  getModuleEventTopics,
  EVENT_SIGNATURES,
} from './services/decoder.js';
import { handleEvent } from './events/index.js';
import { logger } from './utils/logger.js';
import { getModuleContractAddresses } from './utils/modules.js';

export class Indexer {
  private isRunning = false;
  private trackedWallets: Set<string> = new Set();

  async start(): Promise<void> {
    logger.info('Starting indexer...');

    // Load tracked wallets
    const wallets = await supabase.getAllWalletAddresses();
    wallets.forEach((w) => this.trackedWallets.add(w.toLowerCase()));
    logger.info({ count: this.trackedWallets.size }, 'Loaded tracked wallets');

    // Log module contracts being watched
    const moduleContracts = getModuleContractAddresses();
    logger.info(
      { modules: moduleContracts.length },
      'Watching module contracts'
    );

    // Get current state
    const state = await supabase.getIndexerState();
    const currentBlock = await quai.getBlockNumber();
    const startBlock = Math.max(
      state.lastIndexedBlock + 1,
      config.indexer.startBlock
    );

    logger.info(
      {
        lastIndexed: state.lastIndexedBlock,
        currentBlock,
        startBlock,
      },
      'Indexer state'
    );

    // Backfill if needed
    if (startBlock < currentBlock - config.indexer.confirmations) {
      await this.backfill(
        startBlock,
        currentBlock - config.indexer.confirmations
      );
    }

    // Start real-time indexing
    this.isRunning = true;
    this.poll();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await quai.unsubscribe();
    logger.info('Indexer stopped');
  }

  private async backfill(fromBlock: number, toBlock: number): Promise<void> {
    logger.info({ fromBlock, toBlock }, 'Starting backfill');
    await supabase.setIsSyncing(true);

    const batchSize = config.indexer.batchSize;

    for (let start = fromBlock; start <= toBlock; start += batchSize) {
      const end = Math.min(start + batchSize - 1, toBlock);

      try {
        await this.indexBlockRange(start, end);
        await supabase.updateIndexerState(end);

        const progress = (
          ((end - fromBlock) / (toBlock - fromBlock)) *
          100
        ).toFixed(1);
        logger.info(
          { start, end, progress: `${progress}%` },
          'Backfill progress'
        );
      } catch (error) {
        logger.error({ error, start, end }, 'Backfill batch failed');
        throw error;
      }
    }

    await supabase.setIsSyncing(false);
    logger.info('Backfill complete');
  }

  private async indexBlockRange(
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    const allLogs: Array<{
      log: Awaited<ReturnType<typeof quai.getLogs>>[number];
      priority: number;
    }> = [];

    // 1. Get factory events (new wallet deployments/registrations) - highest priority
    const factoryLogs = await quai.getLogs(
      config.contracts.proxyFactory,
      [[EVENT_SIGNATURES.WalletCreated, EVENT_SIGNATURES.WalletRegistered]],
      fromBlock,
      toBlock
    );

    for (const log of factoryLogs) {
      allLogs.push({ log, priority: 0 });
    }

    // 2. Get events from all tracked wallets
    // Note: topics must be [[sig1, sig2, ...]] to match ANY signature in topic0
    if (this.trackedWallets.size > 0) {
      const walletLogs = await quai.getLogs(
        Array.from(this.trackedWallets),
        [getAllEventTopics()],
        fromBlock,
        toBlock
      );

      for (const log of walletLogs) {
        allLogs.push({ log, priority: 1 });
      }
    }

    // 3. Get events from module contracts
    const moduleAddresses = getModuleContractAddresses();
    if (moduleAddresses.length > 0) {
      const moduleLogs = await quai.getLogs(
        moduleAddresses,
        [getModuleEventTopics()],
        fromBlock,
        toBlock
      );

      for (const log of moduleLogs) {
        allLogs.push({ log, priority: 2 });
      }
    }

    // Sort by block number, then log index, then priority
    // This ensures factory events are processed first within the same block
    allLogs.sort((a, b) => {
      if (a.log.blockNumber !== b.log.blockNumber) {
        return a.log.blockNumber - b.log.blockNumber;
      }
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.log.index - b.log.index;
    });

    // Process all events
    for (const { log } of allLogs) {
      const event = decodeEvent(log);
      if (event) {
        // Track new wallets from factory events
        if (event.name === 'WalletCreated' || event.name === 'WalletRegistered') {
          const walletAddress = event.args.wallet as string;
          this.trackedWallets.add(walletAddress.toLowerCase());
        }
        await handleEvent(event);
      }
    }
  }

  private async poll(): Promise<void> {
    while (this.isRunning) {
      try {
        const state = await supabase.getIndexerState();
        const currentBlock = await quai.getBlockNumber();
        const safeBlock = currentBlock - config.indexer.confirmations;

        if (state.lastIndexedBlock < safeBlock) {
          await this.indexBlockRange(state.lastIndexedBlock + 1, safeBlock);
          await supabase.updateIndexerState(safeBlock);
        }
      } catch (error) {
        logger.error({ error }, 'Poll error');
      }

      await this.sleep(config.indexer.pollInterval);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
