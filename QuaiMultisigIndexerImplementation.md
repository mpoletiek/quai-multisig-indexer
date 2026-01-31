# Quai Multisig Indexer Implementation Guide

## Overview

This document provides a complete implementation guide for building an indexing service for the Quai Multisig application using Supabase as the database backend. The indexer will replace the current RPC polling approach (limited to ~5,000 blocks / ~7 hours) with a persistent, queryable data layer.

### Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                      Indexer Service                            │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │ Event       │  │ Block        │  │ Real-time               │ │
│  │ Listener    │──│ Processor    │──│ Notifier (Supabase)     │ │
│  └─────────────┘  └──────────────┘  └─────────────────────────┘ │
│         │                │                      │               │
│         ▼                ▼                      ▼               │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Supabase                                 ││
│  │  PostgreSQL + Realtime + Edge Functions                     ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Quai Network RPC                             │
│                 https://rpc.quai.network/cyprus1                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 1: Supabase Setup

### 1.1 Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Note your project URL and API keys (anon key, service role key)
3. Enable Realtime for the tables we'll create

### 1.2 Database Schema

Run these SQL migrations in the Supabase SQL Editor:

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- CORE TABLES
-- ============================================

-- Indexed wallets (deployed multisig instances)
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    address TEXT UNIQUE NOT NULL,
    name TEXT,
    threshold INTEGER NOT NULL,
    owner_count INTEGER NOT NULL,
    created_at_block BIGINT NOT NULL,
    created_at_tx TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Wallet owners
CREATE TABLE wallet_owners (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    owner_address TEXT NOT NULL,
    added_at_block BIGINT NOT NULL,
    added_at_tx TEXT NOT NULL,
    removed_at_block BIGINT,
    removed_at_tx TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wallet_address, owner_address, added_at_block)
);

-- Multisig transactions
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    transaction_id BIGINT NOT NULL,  -- On-chain nonce/ID
    to_address TEXT NOT NULL,
    value TEXT NOT NULL,  -- Store as string to handle large numbers
    data TEXT,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, executed, cancelled
    confirmation_count INTEGER DEFAULT 0,
    submitted_by TEXT NOT NULL,
    submitted_at_block BIGINT NOT NULL,
    submitted_at_tx TEXT NOT NULL,
    executed_at_block BIGINT,
    executed_at_tx TEXT,
    cancelled_at_block BIGINT,
    cancelled_at_tx TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wallet_address, transaction_id)
);

-- Transaction confirmations
CREATE TABLE confirmations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL,
    transaction_id BIGINT NOT NULL,
    owner_address TEXT NOT NULL,
    confirmed_at_block BIGINT NOT NULL,
    confirmed_at_tx TEXT NOT NULL,
    revoked_at_block BIGINT,
    revoked_at_tx TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (wallet_address, transaction_id) 
        REFERENCES transactions(wallet_address, transaction_id) ON DELETE CASCADE,
    UNIQUE(wallet_address, transaction_id, owner_address, confirmed_at_block)
);

-- Indexer state (track sync progress)
CREATE TABLE indexer_state (
    id TEXT PRIMARY KEY DEFAULT 'main',
    last_indexed_block BIGINT NOT NULL DEFAULT 0,
    last_indexed_at TIMESTAMPTZ,
    is_syncing BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Initialize indexer state
INSERT INTO indexer_state (id, last_indexed_block) VALUES ('main', 0);

-- ============================================
-- MODULE TABLES (Optional - for module events)
-- ============================================

-- Daily limit module state
CREATE TABLE daily_limit_state (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    daily_limit TEXT NOT NULL,
    spent_today TEXT DEFAULT '0',
    last_reset_day DATE NOT NULL DEFAULT CURRENT_DATE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wallet_address)
);

-- Whitelist module state
CREATE TABLE whitelist_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    whitelisted_address TEXT NOT NULL,
    added_at_block BIGINT NOT NULL,
    removed_at_block BIGINT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wallet_address, whitelisted_address, added_at_block)
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_wallet_owners_wallet ON wallet_owners(wallet_address);
CREATE INDEX idx_wallet_owners_active ON wallet_owners(wallet_address) WHERE is_active = TRUE;
CREATE INDEX idx_transactions_wallet ON transactions(wallet_address);
CREATE INDEX idx_transactions_status ON transactions(wallet_address, status);
CREATE INDEX idx_transactions_pending ON transactions(wallet_address) WHERE status = 'pending';
CREATE INDEX idx_confirmations_tx ON confirmations(wallet_address, transaction_id);
CREATE INDEX idx_confirmations_active ON confirmations(wallet_address, transaction_id) WHERE is_active = TRUE;

-- ============================================
-- FUNCTIONS
-- ============================================

-- Update confirmation count trigger
CREATE OR REPLACE FUNCTION update_confirmation_count()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE transactions
    SET 
        confirmation_count = (
            SELECT COUNT(*) FROM confirmations 
            WHERE wallet_address = NEW.wallet_address 
            AND transaction_id = NEW.transaction_id 
            AND is_active = TRUE
        ),
        updated_at = NOW()
    WHERE wallet_address = NEW.wallet_address 
    AND transaction_id = NEW.transaction_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_confirmation_count
AFTER INSERT OR UPDATE ON confirmations
FOR EACH ROW EXECUTE FUNCTION update_confirmation_count();

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_wallets_updated_at
BEFORE UPDATE ON wallets
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_transactions_updated_at
BEFORE UPDATE ON transactions
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- ROW LEVEL SECURITY (Optional)
-- ============================================

-- Enable RLS
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmations ENABLE ROW LEVEL SECURITY;

-- Public read access (adjust as needed)
CREATE POLICY "Public read access" ON wallets FOR SELECT USING (true);
CREATE POLICY "Public read access" ON wallet_owners FOR SELECT USING (true);
CREATE POLICY "Public read access" ON transactions FOR SELECT USING (true);
CREATE POLICY "Public read access" ON confirmations FOR SELECT USING (true);

-- Service role write access
CREATE POLICY "Service write access" ON wallets FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON wallet_owners FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON transactions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON confirmations FOR ALL USING (auth.role() = 'service_role');
```

### 1.3 Enable Realtime

In Supabase Dashboard → Database → Replication:

Enable realtime for these tables:
- `transactions`
- `confirmations`
- `wallet_owners`

---

## Part 2: Indexer Service Implementation

### 2.1 Project Structure

```
indexer/
├── src/
│   ├── index.ts              # Main entry point
│   ├── config.ts             # Configuration
│   ├── indexer.ts            # Core indexer logic
│   ├── events/
│   │   ├── index.ts          # Event handler registry
│   │   ├── wallet.ts         # Wallet creation events
│   │   ├── transaction.ts    # Transaction events
│   │   ├── confirmation.ts   # Confirmation events
│   │   └── owner.ts          # Owner management events
│   ├── services/
│   │   ├── quai.ts           # Quai RPC client
│   │   ├── supabase.ts       # Supabase client
│   │   └── decoder.ts        # Event log decoder
│   ├── types/
│   │   └── index.ts          # TypeScript types
│   └── utils/
│       ├── logger.ts         # Logging utility
│       └── retry.ts          # Retry logic
├── abis/
│   ├── MultisigWallet.json
│   └── ProxyFactory.json
├── package.json
├── tsconfig.json
└── .env.example
```

### 2.2 Package Dependencies

```json
{
  "name": "quai-multisig-indexer",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "build": "tsc",
    "backfill": "tsx src/backfill.ts"
  },
  "dependencies": {
    "quais": "^1.0.0",
    "@supabase/supabase-js": "^2.39.0",
    "dotenv": "^16.3.1",
    "pino": "^8.17.0",
    "pino-pretty": "^10.3.0"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "tsx": "^4.6.0",
    "typescript": "^5.3.0"
  }
}
```

### 2.3 Configuration

```typescript
// src/config.ts
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
    serviceKey: process.env.SUPABASE_SERVICE_KEY!,  // Use service role key for writes
  },
  
  // Contracts
  contracts: {
    proxyFactory: process.env.PROXY_FACTORY_ADDRESS!,
    multisigImplementation: process.env.MULTISIG_IMPLEMENTATION_ADDRESS!,
  },
  
  // Indexer settings
  indexer: {
    batchSize: parseInt(process.env.BATCH_SIZE || '1000'),
    pollInterval: parseInt(process.env.POLL_INTERVAL || '5000'),  // ms
    startBlock: parseInt(process.env.START_BLOCK || '0'),
    confirmations: parseInt(process.env.CONFIRMATIONS || '2'),  // blocks to wait
  },
};
```

### 2.4 Type Definitions

```typescript
// src/types/index.ts

export interface Wallet {
  address: string;
  name?: string;
  threshold: number;
  ownerCount: number;
  createdAtBlock: number;
  createdAtTx: string;
}

export interface WalletOwner {
  walletAddress: string;
  ownerAddress: string;
  addedAtBlock: number;
  addedAtTx: string;
  removedAtBlock?: number;
  removedAtTx?: string;
  isActive: boolean;
}

export interface MultisigTransaction {
  walletAddress: string;
  transactionId: number;
  to: string;
  value: string;
  data: string;
  status: 'pending' | 'executed' | 'cancelled';
  confirmationCount: number;
  submittedBy: string;
  submittedAtBlock: number;
  submittedAtTx: string;
  executedAtBlock?: number;
  executedAtTx?: string;
  cancelledAtBlock?: number;
  cancelledAtTx?: string;
}

export interface Confirmation {
  walletAddress: string;
  transactionId: number;
  ownerAddress: string;
  confirmedAtBlock: number;
  confirmedAtTx: string;
  revokedAtBlock?: number;
  revokedAtTx?: string;
  isActive: boolean;
}

export interface IndexerState {
  lastIndexedBlock: number;
  lastIndexedAt: Date;
  isSyncing: boolean;
}

export interface DecodedEvent {
  name: string;
  args: Record<string, any>;
  address: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}
```

### 2.5 Supabase Client

```typescript
// src/services/supabase.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import type { 
  Wallet, 
  WalletOwner, 
  MultisigTransaction, 
  Confirmation,
  IndexerState 
} from '../types/index.js';
import { logger } from '../utils/logger.js';

class SupabaseService {
  private client: SupabaseClient;

  constructor() {
    this.client = createClient(
      config.supabase.url,
      config.supabase.serviceKey,
      {
        auth: { persistSession: false }
      }
    );
  }

  // ============================================
  // INDEXER STATE
  // ============================================

  async getIndexerState(): Promise<IndexerState> {
    const { data, error } = await this.client
      .from('indexer_state')
      .select('*')
      .eq('id', 'main')
      .single();

    if (error) throw error;
    
    return {
      lastIndexedBlock: data.last_indexed_block,
      lastIndexedAt: new Date(data.last_indexed_at),
      isSyncing: data.is_syncing,
    };
  }

  async updateIndexerState(blockNumber: number): Promise<void> {
    const { error } = await this.client
      .from('indexer_state')
      .update({
        last_indexed_block: blockNumber,
        last_indexed_at: new Date().toISOString(),
      })
      .eq('id', 'main');

    if (error) throw error;
  }

  async setIsSyncing(isSyncing: boolean): Promise<void> {
    const { error } = await this.client
      .from('indexer_state')
      .update({ is_syncing: isSyncing })
      .eq('id', 'main');

    if (error) throw error;
  }

  // ============================================
  // WALLETS
  // ============================================

  async upsertWallet(wallet: Wallet): Promise<void> {
    const { error } = await this.client
      .from('wallets')
      .upsert({
        address: wallet.address.toLowerCase(),
        name: wallet.name,
        threshold: wallet.threshold,
        owner_count: wallet.ownerCount,
        created_at_block: wallet.createdAtBlock,
        created_at_tx: wallet.createdAtTx,
      }, {
        onConflict: 'address'
      });

    if (error) throw error;
    logger.info({ address: wallet.address }, 'Wallet indexed');
  }

  async getWallet(address: string): Promise<Wallet | null> {
    const { data, error } = await this.client
      .from('wallets')
      .select('*')
      .eq('address', address.toLowerCase())
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return null;

    return {
      address: data.address,
      name: data.name,
      threshold: data.threshold,
      ownerCount: data.owner_count,
      createdAtBlock: data.created_at_block,
      createdAtTx: data.created_at_tx,
    };
  }

  async getAllWalletAddresses(): Promise<string[]> {
    const { data, error } = await this.client
      .from('wallets')
      .select('address');

    if (error) throw error;
    return data.map(w => w.address);
  }

  async updateWalletThreshold(address: string, threshold: number): Promise<void> {
    const { error } = await this.client
      .from('wallets')
      .update({ threshold })
      .eq('address', address.toLowerCase());

    if (error) throw error;
  }

  // ============================================
  // OWNERS
  // ============================================

  async addOwner(owner: WalletOwner): Promise<void> {
    const { error } = await this.client
      .from('wallet_owners')
      .insert({
        wallet_address: owner.walletAddress.toLowerCase(),
        owner_address: owner.ownerAddress.toLowerCase(),
        added_at_block: owner.addedAtBlock,
        added_at_tx: owner.addedAtTx,
        is_active: true,
      });

    if (error && error.code !== '23505') throw error; // Ignore duplicate
    logger.info({ wallet: owner.walletAddress, owner: owner.ownerAddress }, 'Owner added');
  }

  async removeOwner(
    walletAddress: string, 
    ownerAddress: string, 
    removedAtBlock: number, 
    removedAtTx: string
  ): Promise<void> {
    const { error } = await this.client
      .from('wallet_owners')
      .update({
        is_active: false,
        removed_at_block: removedAtBlock,
        removed_at_tx: removedAtTx,
      })
      .eq('wallet_address', walletAddress.toLowerCase())
      .eq('owner_address', ownerAddress.toLowerCase())
      .eq('is_active', true);

    if (error) throw error;
    logger.info({ wallet: walletAddress, owner: ownerAddress }, 'Owner removed');
  }

  // ============================================
  // TRANSACTIONS
  // ============================================

  async upsertTransaction(tx: MultisigTransaction): Promise<void> {
    const { error } = await this.client
      .from('transactions')
      .upsert({
        wallet_address: tx.walletAddress.toLowerCase(),
        transaction_id: tx.transactionId,
        to_address: tx.to.toLowerCase(),
        value: tx.value,
        data: tx.data,
        status: tx.status,
        confirmation_count: tx.confirmationCount,
        submitted_by: tx.submittedBy.toLowerCase(),
        submitted_at_block: tx.submittedAtBlock,
        submitted_at_tx: tx.submittedAtTx,
        executed_at_block: tx.executedAtBlock,
        executed_at_tx: tx.executedAtTx,
        cancelled_at_block: tx.cancelledAtBlock,
        cancelled_at_tx: tx.cancelledAtTx,
      }, {
        onConflict: 'wallet_address,transaction_id'
      });

    if (error) throw error;
    logger.info({ 
      wallet: tx.walletAddress, 
      txId: tx.transactionId, 
      status: tx.status 
    }, 'Transaction indexed');
  }

  async updateTransactionStatus(
    walletAddress: string,
    transactionId: number,
    status: 'executed' | 'cancelled',
    blockNumber: number,
    txHash: string
  ): Promise<void> {
    const updateData: Record<string, any> = { status };
    
    if (status === 'executed') {
      updateData.executed_at_block = blockNumber;
      updateData.executed_at_tx = txHash;
    } else {
      updateData.cancelled_at_block = blockNumber;
      updateData.cancelled_at_tx = txHash;
    }

    const { error } = await this.client
      .from('transactions')
      .update(updateData)
      .eq('wallet_address', walletAddress.toLowerCase())
      .eq('transaction_id', transactionId);

    if (error) throw error;
    logger.info({ wallet: walletAddress, txId: transactionId, status }, 'Transaction status updated');
  }

  // ============================================
  // CONFIRMATIONS
  // ============================================

  async addConfirmation(confirmation: Confirmation): Promise<void> {
    const { error } = await this.client
      .from('confirmations')
      .insert({
        wallet_address: confirmation.walletAddress.toLowerCase(),
        transaction_id: confirmation.transactionId,
        owner_address: confirmation.ownerAddress.toLowerCase(),
        confirmed_at_block: confirmation.confirmedAtBlock,
        confirmed_at_tx: confirmation.confirmedAtTx,
        is_active: true,
      });

    if (error && error.code !== '23505') throw error; // Ignore duplicate
    logger.info({ 
      wallet: confirmation.walletAddress, 
      txId: confirmation.transactionId,
      owner: confirmation.ownerAddress 
    }, 'Confirmation added');
  }

  async revokeConfirmation(
    walletAddress: string,
    transactionId: number,
    ownerAddress: string,
    revokedAtBlock: number,
    revokedAtTx: string
  ): Promise<void> {
    const { error } = await this.client
      .from('confirmations')
      .update({
        is_active: false,
        revoked_at_block: revokedAtBlock,
        revoked_at_tx: revokedAtTx,
      })
      .eq('wallet_address', walletAddress.toLowerCase())
      .eq('transaction_id', transactionId)
      .eq('owner_address', ownerAddress.toLowerCase())
      .eq('is_active', true);

    if (error) throw error;
    logger.info({ 
      wallet: walletAddress, 
      txId: transactionId,
      owner: ownerAddress 
    }, 'Confirmation revoked');
  }
}

export const supabase = new SupabaseService();
```

### 2.6 Quai Network Client

```typescript
// src/services/quai.ts
import { quais } from 'quais';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

class QuaiService {
  private provider: quais.JsonRpcProvider;
  private wsProvider: quais.WebSocketProvider | null = null;

  constructor() {
    this.provider = new quais.JsonRpcProvider(
      config.quai.rpcUrl,
      undefined,
      { usePathing: true }
    );
  }

  async getBlockNumber(): Promise<number> {
    return await this.provider.getBlockNumber();
  }

  async getLogs(
    address: string | string[],
    topics: (string | string[] | null)[],
    fromBlock: number,
    toBlock: number
  ): Promise<quais.Log[]> {
    return await this.provider.getLogs({
      address,
      topics,
      fromBlock,
      toBlock,
    });
  }

  async getBlock(blockNumber: number): Promise<quais.Block | null> {
    return await this.provider.getBlock(blockNumber);
  }

  getContract(address: string, abi: any[]): quais.Contract {
    return new quais.Contract(address, abi, this.provider);
  }

  // WebSocket for real-time events
  async subscribeToEvents(
    addresses: string[],
    topics: string[],
    callback: (log: quais.Log) => void
  ): Promise<void> {
    if (!this.wsProvider) {
      this.wsProvider = new quais.WebSocketProvider(
        config.quai.wsUrl,
        undefined,
        { usePathing: true }
      );
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
```

### 2.7 Event Decoder

```typescript
// src/services/decoder.ts
import { quais } from 'quais';
import type { DecodedEvent } from '../types/index.js';

// Event signatures (keccak256 hashes)
export const EVENT_SIGNATURES = {
  // ProxyFactory
  WalletCreated: quais.id('WalletCreated(address,address[],uint256)'),
  
  // MultisigWallet
  TransactionSubmitted: quais.id('TransactionSubmitted(uint256,address,uint256,bytes)'),
  TransactionConfirmed: quais.id('TransactionConfirmed(uint256,address)'),
  TransactionRevoked: quais.id('TransactionRevoked(uint256,address)'),
  TransactionExecuted: quais.id('TransactionExecuted(uint256)'),
  TransactionCancelled: quais.id('TransactionCancelled(uint256)'),
  OwnerAdded: quais.id('OwnerAdded(address)'),
  OwnerRemoved: quais.id('OwnerRemoved(address)'),
  ThresholdChanged: quais.id('ThresholdChanged(uint256)'),
  
  // Modules (optional)
  DailyLimitChanged: quais.id('DailyLimitChanged(uint256)'),
  WhitelistAdded: quais.id('WhitelistAdded(address)'),
  WhitelistRemoved: quais.id('WhitelistRemoved(address)'),
};

// ABI fragments for decoding
const EVENT_ABIS: Record<string, string[]> = {
  WalletCreated: ['address wallet', 'address[] owners', 'uint256 threshold'],
  TransactionSubmitted: ['uint256 indexed transactionId', 'address indexed to', 'uint256 value', 'bytes data'],
  TransactionConfirmed: ['uint256 indexed transactionId', 'address indexed owner'],
  TransactionRevoked: ['uint256 indexed transactionId', 'address indexed owner'],
  TransactionExecuted: ['uint256 indexed transactionId'],
  TransactionCancelled: ['uint256 indexed transactionId'],
  OwnerAdded: ['address indexed owner'],
  OwnerRemoved: ['address indexed owner'],
  ThresholdChanged: ['uint256 threshold'],
};

export function decodeEvent(log: quais.Log): DecodedEvent | null {
  const topic0 = log.topics[0];
  
  // Find matching event
  const eventName = Object.entries(EVENT_SIGNATURES).find(
    ([_, sig]) => sig === topic0
  )?.[0];

  if (!eventName) return null;

  const abiFragment = EVENT_ABIS[eventName];
  if (!abiFragment) return null;

  try {
    const iface = new quais.Interface([
      `event ${eventName}(${abiFragment.join(', ')})`
    ]);
    
    const decoded = iface.parseLog({
      topics: log.topics as string[],
      data: log.data,
    });

    if (!decoded) return null;

    // Convert to plain object
    const args: Record<string, any> = {};
    decoded.fragment.inputs.forEach((input, i) => {
      const value = decoded.args[i];
      args[input.name] = typeof value === 'bigint' ? value.toString() : value;
    });

    return {
      name: eventName,
      args,
      address: log.address,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    };
  } catch (error) {
    return null;
  }
}

export function getAllEventTopics(): string[] {
  return Object.values(EVENT_SIGNATURES);
}

export function getMultisigEventTopics(): string[] {
  return [
    EVENT_SIGNATURES.TransactionSubmitted,
    EVENT_SIGNATURES.TransactionConfirmed,
    EVENT_SIGNATURES.TransactionRevoked,
    EVENT_SIGNATURES.TransactionExecuted,
    EVENT_SIGNATURES.TransactionCancelled,
    EVENT_SIGNATURES.OwnerAdded,
    EVENT_SIGNATURES.OwnerRemoved,
    EVENT_SIGNATURES.ThresholdChanged,
  ];
}
```

### 2.8 Event Handlers

```typescript
// src/events/index.ts
import type { DecodedEvent } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { logger } from '../utils/logger.js';

export async function handleEvent(event: DecodedEvent): Promise<void> {
  try {
    switch (event.name) {
      case 'WalletCreated':
        await handleWalletCreated(event);
        break;
      case 'TransactionSubmitted':
        await handleTransactionSubmitted(event);
        break;
      case 'TransactionConfirmed':
        await handleTransactionConfirmed(event);
        break;
      case 'TransactionRevoked':
        await handleTransactionRevoked(event);
        break;
      case 'TransactionExecuted':
        await handleTransactionExecuted(event);
        break;
      case 'TransactionCancelled':
        await handleTransactionCancelled(event);
        break;
      case 'OwnerAdded':
        await handleOwnerAdded(event);
        break;
      case 'OwnerRemoved':
        await handleOwnerRemoved(event);
        break;
      case 'ThresholdChanged':
        await handleThresholdChanged(event);
        break;
      default:
        logger.debug({ event: event.name }, 'Unhandled event');
    }
  } catch (error) {
    logger.error({ error, event }, 'Error handling event');
    throw error;
  }
}

async function handleWalletCreated(event: DecodedEvent): Promise<void> {
  const { wallet, owners, threshold } = event.args;
  
  // Index the wallet
  await supabase.upsertWallet({
    address: wallet,
    threshold: parseInt(threshold),
    ownerCount: owners.length,
    createdAtBlock: event.blockNumber,
    createdAtTx: event.transactionHash,
  });

  // Index all owners
  for (const owner of owners) {
    await supabase.addOwner({
      walletAddress: wallet,
      ownerAddress: owner,
      addedAtBlock: event.blockNumber,
      addedAtTx: event.transactionHash,
      isActive: true,
    });
  }
}

async function handleTransactionSubmitted(event: DecodedEvent): Promise<void> {
  const { transactionId, to, value, data } = event.args;
  
  // Get submitter from transaction (would need tx receipt in practice)
  // For now, we'll use the 'to' indexed param which is actually the submitter
  await supabase.upsertTransaction({
    walletAddress: event.address,
    transactionId: parseInt(transactionId),
    to: to,
    value: value,
    data: data || '0x',
    status: 'pending',
    confirmationCount: 1, // Submitter auto-confirms
    submittedBy: to, // This should be parsed from tx receipt
    submittedAtBlock: event.blockNumber,
    submittedAtTx: event.transactionHash,
  });
}

async function handleTransactionConfirmed(event: DecodedEvent): Promise<void> {
  const { transactionId, owner } = event.args;

  await supabase.addConfirmation({
    walletAddress: event.address,
    transactionId: parseInt(transactionId),
    ownerAddress: owner,
    confirmedAtBlock: event.blockNumber,
    confirmedAtTx: event.transactionHash,
    isActive: true,
  });
}

async function handleTransactionRevoked(event: DecodedEvent): Promise<void> {
  const { transactionId, owner } = event.args;

  await supabase.revokeConfirmation(
    event.address,
    parseInt(transactionId),
    owner,
    event.blockNumber,
    event.transactionHash
  );
}

async function handleTransactionExecuted(event: DecodedEvent): Promise<void> {
  const { transactionId } = event.args;

  await supabase.updateTransactionStatus(
    event.address,
    parseInt(transactionId),
    'executed',
    event.blockNumber,
    event.transactionHash
  );
}

async function handleTransactionCancelled(event: DecodedEvent): Promise<void> {
  const { transactionId } = event.args;

  await supabase.updateTransactionStatus(
    event.address,
    parseInt(transactionId),
    'cancelled',
    event.blockNumber,
    event.transactionHash
  );
}

async function handleOwnerAdded(event: DecodedEvent): Promise<void> {
  const { owner } = event.args;

  await supabase.addOwner({
    walletAddress: event.address,
    ownerAddress: owner,
    addedAtBlock: event.blockNumber,
    addedAtTx: event.transactionHash,
    isActive: true,
  });

  // Update owner count on wallet
  // (Would need to fetch current count and increment)
}

async function handleOwnerRemoved(event: DecodedEvent): Promise<void> {
  const { owner } = event.args;

  await supabase.removeOwner(
    event.address,
    owner,
    event.blockNumber,
    event.transactionHash
  );
}

async function handleThresholdChanged(event: DecodedEvent): Promise<void> {
  const { threshold } = event.args;

  await supabase.updateWalletThreshold(
    event.address,
    parseInt(threshold)
  );
}
```

### 2.9 Core Indexer

```typescript
// src/indexer.ts
import { config } from './config.js';
import { quai } from './services/quai.js';
import { supabase } from './services/supabase.js';
import { decodeEvent, getAllEventTopics, EVENT_SIGNATURES } from './services/decoder.js';
import { handleEvent } from './events/index.js';
import { logger } from './utils/logger.js';

export class Indexer {
  private isRunning = false;
  private trackedWallets: Set<string> = new Set();

  async start(): Promise<void> {
    logger.info('Starting indexer...');
    
    // Load tracked wallets
    const wallets = await supabase.getAllWalletAddresses();
    wallets.forEach(w => this.trackedWallets.add(w.toLowerCase()));
    logger.info({ count: this.trackedWallets.size }, 'Loaded tracked wallets');

    // Get current state
    const state = await supabase.getIndexerState();
    const currentBlock = await quai.getBlockNumber();
    const startBlock = Math.max(state.lastIndexedBlock + 1, config.indexer.startBlock);

    logger.info({ 
      lastIndexed: state.lastIndexedBlock, 
      currentBlock,
      startBlock 
    }, 'Indexer state');

    // Backfill if needed
    if (startBlock < currentBlock - config.indexer.confirmations) {
      await this.backfill(startBlock, currentBlock - config.indexer.confirmations);
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
        
        const progress = ((end - fromBlock) / (toBlock - fromBlock) * 100).toFixed(1);
        logger.info({ start, end, progress: `${progress}%` }, 'Backfill progress');
      } catch (error) {
        logger.error({ error, start, end }, 'Backfill batch failed');
        throw error;
      }
    }

    await supabase.setIsSyncing(false);
    logger.info('Backfill complete');
  }

  private async indexBlockRange(fromBlock: number, toBlock: number): Promise<void> {
    // Get factory events (new wallet deployments)
    const factoryLogs = await quai.getLogs(
      config.contracts.proxyFactory,
      [EVENT_SIGNATURES.WalletCreated],
      fromBlock,
      toBlock
    );

    // Process factory events first to discover new wallets
    for (const log of factoryLogs) {
      const event = decodeEvent(log);
      if (event) {
        await handleEvent(event);
        if (event.name === 'WalletCreated') {
          this.trackedWallets.add(event.args.wallet.toLowerCase());
        }
      }
    }

    // Get events from all tracked wallets
    if (this.trackedWallets.size > 0) {
      const walletLogs = await quai.getLogs(
        Array.from(this.trackedWallets),
        getAllEventTopics(),
        fromBlock,
        toBlock
      );

      // Sort by block and log index
      walletLogs.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return a.blockNumber - b.blockNumber;
        }
        return a.index - b.index;
      });

      // Process wallet events
      for (const log of walletLogs) {
        const event = decodeEvent(log);
        if (event) {
          await handleEvent(event);
        }
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
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### 2.10 Main Entry Point

```typescript
// src/index.ts
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
```

### 2.11 Logger Utility

```typescript
// src/utils/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' 
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});
```

---

## Part 3: Frontend Integration

### 3.1 Supabase Client Setup (Frontend)

```typescript
// frontend/src/services/supabase.ts
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
```

### 3.2 React Hooks for Data Fetching

```typescript
// frontend/src/hooks/useWalletTransactions.ts
import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface Transaction {
  id: string;
  transactionId: number;
  to: string;
  value: string;
  status: 'pending' | 'executed' | 'cancelled';
  confirmationCount: number;
  submittedBy: string;
  submittedAtBlock: number;
}

export function useWalletTransactions(walletAddress: string) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let channel: RealtimeChannel;

    async function fetchTransactions() {
      try {
        const { data, error } = await supabase
          .from('transactions')
          .select('*')
          .eq('wallet_address', walletAddress.toLowerCase())
          .order('transaction_id', { ascending: false });

        if (error) throw error;

        setTransactions(data.map(tx => ({
          id: tx.id,
          transactionId: tx.transaction_id,
          to: tx.to_address,
          value: tx.value,
          status: tx.status,
          confirmationCount: tx.confirmation_count,
          submittedBy: tx.submitted_by,
          submittedAtBlock: tx.submitted_at_block,
        })));
      } catch (err) {
        setError(err as Error);
      } finally {
        setLoading(false);
      }
    }

    // Initial fetch
    fetchTransactions();

    // Subscribe to realtime updates
    channel = supabase
      .channel(`transactions:${walletAddress}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'transactions',
          filter: `wallet_address=eq.${walletAddress.toLowerCase()}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setTransactions(prev => [mapTransaction(payload.new), ...prev]);
          } else if (payload.eventType === 'UPDATE') {
            setTransactions(prev =>
              prev.map(tx =>
                tx.id === payload.new.id ? mapTransaction(payload.new) : tx
              )
            );
          }
        }
      )
      .subscribe();

    return () => {
      channel?.unsubscribe();
    };
  }, [walletAddress]);

  return { transactions, loading, error };
}

function mapTransaction(data: any): Transaction {
  return {
    id: data.id,
    transactionId: data.transaction_id,
    to: data.to_address,
    value: data.value,
    status: data.status,
    confirmationCount: data.confirmation_count,
    submittedBy: data.submitted_by,
    submittedAtBlock: data.submitted_at_block,
  };
}
```

### 3.3 Pending Transactions Hook

```typescript
// frontend/src/hooks/usePendingTransactions.ts
import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';

export function usePendingTransactions(walletAddress: string) {
  const [pending, setPending] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetch() {
      const { data, error } = await supabase
        .from('transactions')
        .select(`
          *,
          confirmations (
            owner_address,
            is_active
          )
        `)
        .eq('wallet_address', walletAddress.toLowerCase())
        .eq('status', 'pending')
        .order('transaction_id', { ascending: true });

      if (!error && data) {
        setPending(data);
      }
      setLoading(false);
    }

    fetch();

    // Realtime subscription
    const channel = supabase
      .channel(`pending:${walletAddress}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'transactions',
          filter: `wallet_address=eq.${walletAddress.toLowerCase()}`,
        },
        () => fetch() // Refetch on any change
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'confirmations',
          filter: `wallet_address=eq.${walletAddress.toLowerCase()}`,
        },
        () => fetch()
      )
      .subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, [walletAddress]);

  return { pending, loading };
}
```

---

## Part 4: Deployment

### 4.1 Environment Variables

```bash
# .env.example

# Quai Network
QUAI_RPC_URL=https://rpc.quai.network/cyprus1
QUAI_WS_URL=wss://rpc.quai.network/cyprus1

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

# Contracts
PROXY_FACTORY_ADDRESS=0x...
MULTISIG_IMPLEMENTATION_ADDRESS=0x...

# Indexer Settings
BATCH_SIZE=1000
POLL_INTERVAL=5000
START_BLOCK=0
CONFIRMATIONS=2

# Logging
LOG_LEVEL=info
NODE_ENV=production
```

### 4.2 Docker Deployment

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist

CMD ["node", "dist/index.js"]
```

```yaml
# docker-compose.yml
version: '3.8'

services:
  indexer:
    build: .
    restart: unless-stopped
    env_file:
      - .env
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

### 4.3 Deployment Options

**Option A: Railway / Render / Fly.io**
- Deploy as a background worker
- Set environment variables in dashboard
- Enable auto-restart

**Option B: Supabase Edge Functions (Limited)**
- Can't run long-lived processes
- Use for webhook endpoints or scheduled tasks only

**Option C: VPS (DigitalOcean, Linode)**
- Run with PM2 or systemd
- More control, more maintenance

---

## Part 5: API Queries (Supabase)

### 5.1 Useful Queries

```typescript
// Get all pending transactions for a wallet
const { data } = await supabase
  .from('transactions')
  .select(`
    *,
    confirmations!inner (
      owner_address,
      is_active
    )
  `)
  .eq('wallet_address', address)
  .eq('status', 'pending');

// Get wallet with owners
const { data } = await supabase
  .from('wallets')
  .select(`
    *,
    wallet_owners!inner (
      owner_address,
      is_active
    )
  `)
  .eq('address', address)
  .single();

// Get transaction history (last 50)
const { data } = await supabase
  .from('transactions')
  .select('*')
  .eq('wallet_address', address)
  .in('status', ['executed', 'cancelled'])
  .order('submitted_at_block', { ascending: false })
  .limit(50);

// Search for a specific transaction by ID
const { data } = await supabase
  .from('transactions')
  .select('*')
  .eq('wallet_address', address)
  .eq('transaction_id', txId)
  .single();
```

---

## Part 6: Testing Checklist

- [ ] Indexer starts and connects to Quai RPC
- [ ] Indexer connects to Supabase
- [ ] Factory events create wallet records
- [ ] Transaction submitted events create transaction records
- [ ] Confirmation events update confirmation counts
- [ ] Revocation events mark confirmations inactive
- [ ] Execution events update transaction status
- [ ] Cancellation events update transaction status
- [ ] Owner added/removed events update wallet_owners
- [ ] Threshold changed events update wallet threshold
- [ ] Backfill correctly processes historical blocks
- [ ] Real-time polling catches new blocks
- [ ] Frontend receives realtime updates via Supabase
- [ ] Graceful shutdown works correctly

---

## Summary

This implementation provides:

1. **Persistent storage** via Supabase PostgreSQL
2. **Real-time updates** via Supabase Realtime subscriptions  
3. **Complete transaction history** beyond the 7-hour RPC limit
4. **Automatic wallet discovery** via ProxyFactory events
5. **Confirmation tracking** with active/revoked state
6. **Owner management** tracking additions and removals
7. **Fault tolerance** with resume-from-last-block capability

The indexer runs as a standalone Node.js service that can be deployed anywhere, while the frontend connects directly to Supabase for queries and real-time updates.