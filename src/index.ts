import { Indexer } from './indexer.js';
import { logger } from './utils/logger.js';

const indexer = new Indexer();

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...');
  await indexer.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  await indexer.stop();
  process.exit(0);
});

// Start
indexer.start().catch((error) => {
  logger.error({ error }, 'Failed to start indexer');
  process.exit(1);
});
