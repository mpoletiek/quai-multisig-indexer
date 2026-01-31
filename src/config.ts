import 'dotenv/config';

export const config = {
  // Quai Network
  quai: {
    rpcUrl: process.env.QUAI_RPC_URL || 'https://rpc.quai.network/cyprus1',
    wsUrl: process.env.QUAI_WS_URL || 'wss://rpc.quai.network/cyprus1',
    chainId: 9,
  },

  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_KEY!,
  },

  // Contracts
  contracts: {
    proxyFactory: process.env.PROXY_FACTORY_ADDRESS!,
    multisigImplementation: process.env.MULTISIG_IMPLEMENTATION_ADDRESS!,
    dailyLimitModule: process.env.DAILY_LIMIT_MODULE_ADDRESS,
    whitelistModule: process.env.WHITELIST_MODULE_ADDRESS,
    socialRecoveryModule: process.env.SOCIAL_RECOVERY_MODULE_ADDRESS,
  },

  // Indexer settings
  indexer: {
    batchSize: parseInt(process.env.BATCH_SIZE || '1000'),
    pollInterval: parseInt(process.env.POLL_INTERVAL || '5000'),
    startBlock: parseInt(process.env.START_BLOCK || '0'),
    confirmations: parseInt(process.env.CONFIRMATIONS || '2'),
  },
};

// Validate required configuration at startup
function validateConfig(): void {
  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'PROXY_FACTORY_ADDRESS',
    'MULTISIG_IMPLEMENTATION_ADDRESS',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        'Please check your .env file or environment configuration.'
    );
  }
}

validateConfig();
