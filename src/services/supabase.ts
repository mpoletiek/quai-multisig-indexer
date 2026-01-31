import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import type {
  Wallet,
  WalletOwner,
  WalletModule,
  MultisigTransaction,
  Confirmation,
  IndexerState,
  SocialRecoveryConfig,
  SocialRecovery,
  SocialRecoveryApproval,
  DailyLimitState,
  WhitelistEntry,
  ModuleTransaction,
} from '../types/index.js';

class SupabaseService {
  private client: SupabaseClient;

  constructor() {
    this.client = createClient(config.supabase.url, config.supabase.serviceKey, {
      auth: { persistSession: false },
    });
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
    const { error } = await this.client.from('wallets').upsert(
      {
        address: wallet.address.toLowerCase(),
        name: wallet.name,
        threshold: wallet.threshold,
        owner_count: wallet.ownerCount,
        created_at_block: wallet.createdAtBlock,
        created_at_tx: wallet.createdAtTx,
      },
      {
        onConflict: 'address',
      }
    );

    if (error) throw error;
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
    const { data, error } = await this.client.from('wallets').select('address');

    if (error) throw error;
    return data.map((w) => w.address);
  }

  async updateWalletThreshold(address: string, threshold: number): Promise<void> {
    const { error } = await this.client
      .from('wallets')
      .update({ threshold })
      .eq('address', address.toLowerCase());

    if (error) throw error;
  }

  async updateWalletOwnerCount(address: string, delta: number): Promise<void> {
    const { error } = await this.client.rpc('increment_owner_count', {
      wallet_addr: address.toLowerCase(),
      delta_value: delta,
    });

    if (error) throw error;
  }

  // ============================================
  // OWNERS
  // ============================================

  async addOwner(owner: WalletOwner): Promise<void> {
    const { error } = await this.client.from('wallet_owners').insert({
      wallet_address: owner.walletAddress.toLowerCase(),
      owner_address: owner.ownerAddress.toLowerCase(),
      added_at_block: owner.addedAtBlock,
      added_at_tx: owner.addedAtTx,
      is_active: true,
    });

    if (error && error.code !== '23505') throw error; // Ignore duplicate
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
  }

  // ============================================
  // MODULES
  // ============================================

  async addModule(module: WalletModule): Promise<void> {
    const { error } = await this.client.from('wallet_modules').upsert(
      {
        wallet_address: module.walletAddress.toLowerCase(),
        module_address: module.moduleAddress.toLowerCase(),
        enabled_at_block: module.enabledAtBlock,
        enabled_at_tx: module.enabledAtTx,
        is_active: true,
      },
      { onConflict: 'wallet_address,module_address' }
    );

    if (error) throw error;
  }

  async disableModule(
    walletAddress: string,
    moduleAddress: string,
    disabledAtBlock: number,
    disabledAtTx: string
  ): Promise<void> {
    const { error } = await this.client
      .from('wallet_modules')
      .update({
        is_active: false,
        disabled_at_block: disabledAtBlock,
        disabled_at_tx: disabledAtTx,
      })
      .eq('wallet_address', walletAddress.toLowerCase())
      .eq('module_address', moduleAddress.toLowerCase())
      .eq('is_active', true);

    if (error) throw error;
  }

  // ============================================
  // TRANSACTIONS
  // ============================================

  async upsertTransaction(tx: MultisigTransaction): Promise<void> {
    const { error } = await this.client.from('transactions').upsert(
      {
        wallet_address: tx.walletAddress.toLowerCase(),
        tx_hash: tx.txHash,
        to_address: tx.to.toLowerCase(),
        value: tx.value,
        data: tx.data,
        transaction_type: tx.transactionType,
        decoded_params: tx.decodedParams || null,
        status: tx.status,
        confirmation_count: tx.confirmationCount,
        submitted_by: tx.submittedBy.toLowerCase(),
        submitted_at_block: tx.submittedAtBlock,
        submitted_at_tx: tx.submittedAtTx,
        executed_at_block: tx.executedAtBlock,
        executed_at_tx: tx.executedAtTx,
        cancelled_at_block: tx.cancelledAtBlock,
        cancelled_at_tx: tx.cancelledAtTx,
      },
      {
        onConflict: 'wallet_address,tx_hash',
      }
    );

    if (error) throw error;
  }

  async updateTransactionStatus(
    walletAddress: string,
    txHash: string,
    status: 'executed' | 'cancelled',
    blockNumber: number,
    chainTxHash: string
  ): Promise<void> {
    const updateData: Record<string, unknown> = { status };

    if (status === 'executed') {
      updateData.executed_at_block = blockNumber;
      updateData.executed_at_tx = chainTxHash;
    } else {
      updateData.cancelled_at_block = blockNumber;
      updateData.cancelled_at_tx = chainTxHash;
    }

    const { error } = await this.client
      .from('transactions')
      .update(updateData)
      .eq('wallet_address', walletAddress.toLowerCase())
      .eq('tx_hash', txHash);

    if (error) throw error;
  }

  // ============================================
  // CONFIRMATIONS
  // ============================================

  async addConfirmation(confirmation: Confirmation): Promise<void> {
    const { error } = await this.client.from('confirmations').insert({
      wallet_address: confirmation.walletAddress.toLowerCase(),
      tx_hash: confirmation.txHash,
      owner_address: confirmation.ownerAddress.toLowerCase(),
      confirmed_at_block: confirmation.confirmedAtBlock,
      confirmed_at_tx: confirmation.confirmedAtTx,
      is_active: true,
    });

    if (error && error.code !== '23505') throw error; // Ignore duplicate
  }

  async revokeConfirmation(
    walletAddress: string,
    txHash: string,
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
      .eq('tx_hash', txHash)
      .eq('owner_address', ownerAddress.toLowerCase())
      .eq('is_active', true);

    if (error) throw error;
  }

  // ============================================
  // SOCIAL RECOVERY MODULE
  // ============================================

  async upsertRecoveryConfig(config: SocialRecoveryConfig): Promise<void> {
    // First, upsert the config
    const { error: configError } = await this.client
      .from('social_recovery_configs')
      .upsert(
        {
          wallet_address: config.walletAddress.toLowerCase(),
          threshold: config.threshold,
          recovery_period: config.recoveryPeriod,
          setup_at_block: config.setupAtBlock,
          setup_at_tx: config.setupAtTx,
        },
        { onConflict: 'wallet_address' }
      );

    if (configError) throw configError;

    // Mark all existing guardians as inactive
    await this.client
      .from('social_recovery_guardians')
      .update({ is_active: false })
      .eq('wallet_address', config.walletAddress.toLowerCase());

    // Add new guardians
    for (const guardian of config.guardians) {
      const { error: guardianError } = await this.client
        .from('social_recovery_guardians')
        .insert({
          wallet_address: config.walletAddress.toLowerCase(),
          guardian_address: guardian.toLowerCase(),
          added_at_block: config.setupAtBlock,
          added_at_tx: config.setupAtTx,
          is_active: true,
        });

      if (guardianError && guardianError.code !== '23505') throw guardianError;
    }
  }

  async upsertRecovery(recovery: SocialRecovery): Promise<void> {
    const { error } = await this.client.from('social_recoveries').upsert(
      {
        wallet_address: recovery.walletAddress.toLowerCase(),
        recovery_hash: recovery.recoveryHash,
        new_owners: recovery.newOwners.map((o) => o.toLowerCase()),
        new_threshold: recovery.newThreshold,
        initiator_address: recovery.initiatorAddress.toLowerCase(),
        approval_count: recovery.approvalCount,
        required_threshold: recovery.requiredThreshold,
        execution_time: recovery.executionTime,
        status: recovery.status,
        initiated_at_block: recovery.initiatedAtBlock,
        initiated_at_tx: recovery.initiatedAtTx,
        executed_at_block: recovery.executedAtBlock,
        executed_at_tx: recovery.executedAtTx,
        cancelled_at_block: recovery.cancelledAtBlock,
        cancelled_at_tx: recovery.cancelledAtTx,
      },
      { onConflict: 'wallet_address,recovery_hash' }
    );

    if (error) throw error;
  }

  async addRecoveryApproval(approval: SocialRecoveryApproval): Promise<void> {
    // The trigger_update_recovery_approval_count automatically updates
    // the approval_count on social_recoveries when an approval is inserted.
    const { error } = await this.client
      .from('social_recovery_approvals')
      .insert({
        wallet_address: approval.walletAddress.toLowerCase(),
        recovery_hash: approval.recoveryHash,
        guardian_address: approval.guardianAddress.toLowerCase(),
        approved_at_block: approval.approvedAtBlock,
        approved_at_tx: approval.approvedAtTx,
        is_active: true,
      });

    if (error && error.code !== '23505') throw error;
  }

  async revokeRecoveryApproval(
    walletAddress: string,
    recoveryHash: string,
    guardianAddress: string,
    revokedAtBlock: number,
    revokedAtTx: string
  ): Promise<void> {
    // The trigger_update_recovery_approval_count automatically updates
    // the approval_count on social_recoveries when an approval is updated.
    const { error } = await this.client
      .from('social_recovery_approvals')
      .update({
        is_active: false,
        revoked_at_block: revokedAtBlock,
        revoked_at_tx: revokedAtTx,
      })
      .eq('wallet_address', walletAddress.toLowerCase())
      .eq('recovery_hash', recoveryHash)
      .eq('guardian_address', guardianAddress.toLowerCase())
      .eq('is_active', true);

    if (error) throw error;
  }

  async updateRecoveryStatus(
    walletAddress: string,
    recoveryHash: string,
    status: 'executed' | 'cancelled',
    blockNumber: number,
    txHash: string
  ): Promise<void> {
    const updateData: Record<string, unknown> = { status };

    if (status === 'executed') {
      updateData.executed_at_block = blockNumber;
      updateData.executed_at_tx = txHash;
    } else {
      updateData.cancelled_at_block = blockNumber;
      updateData.cancelled_at_tx = txHash;
    }

    const { error } = await this.client
      .from('social_recoveries')
      .update(updateData)
      .eq('wallet_address', walletAddress.toLowerCase())
      .eq('recovery_hash', recoveryHash);

    if (error) throw error;
  }

  async getRecoveryConfig(
    walletAddress: string
  ): Promise<{ threshold: number; recoveryPeriod: number } | null> {
    const { data, error } = await this.client
      .from('social_recovery_configs')
      .select('threshold, recovery_period')
      .eq('wallet_address', walletAddress.toLowerCase())
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return null;

    return {
      threshold: data.threshold,
      recoveryPeriod: data.recovery_period,
    };
  }

  // ============================================
  // DAILY LIMIT MODULE
  // ============================================

  async upsertDailyLimit(state: DailyLimitState): Promise<void> {
    const { error } = await this.client.from('daily_limit_state').upsert(
      {
        wallet_address: state.walletAddress.toLowerCase(),
        daily_limit: state.dailyLimit,
        spent_today: state.spentToday,
        last_reset_day: state.lastResetDay,
      },
      { onConflict: 'wallet_address' }
    );

    if (error) throw error;
  }

  async resetDailyLimit(walletAddress: string): Promise<void> {
    const { error } = await this.client
      .from('daily_limit_state')
      .update({
        spent_today: '0',
        last_reset_day: new Date().toISOString().split('T')[0],
      })
      .eq('wallet_address', walletAddress.toLowerCase());

    if (error) throw error;
  }

  async updateDailyLimitSpent(
    walletAddress: string,
    remainingLimit: string
  ): Promise<void> {
    // Get the current daily limit to calculate spent amount
    const { data, error: fetchError } = await this.client
      .from('daily_limit_state')
      .select('daily_limit')
      .eq('wallet_address', walletAddress.toLowerCase())
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;
    if (!data) return; // No daily limit configured for this wallet

    // Calculate spent: daily_limit - remaining_limit
    const dailyLimit = BigInt(data.daily_limit);
    const remaining = BigInt(remainingLimit);
    const spent = (dailyLimit - remaining).toString();

    const { error } = await this.client
      .from('daily_limit_state')
      .update({ spent_today: spent })
      .eq('wallet_address', walletAddress.toLowerCase());

    if (error) throw error;
  }

  // ============================================
  // WHITELIST MODULE
  // ============================================

  async addWhitelistEntry(entry: WhitelistEntry): Promise<void> {
    const { error } = await this.client.from('whitelist_entries').insert({
      wallet_address: entry.walletAddress.toLowerCase(),
      whitelisted_address: entry.whitelistedAddress.toLowerCase(),
      limit_amount: entry.limit,
      added_at_block: entry.addedAtBlock,
      added_at_tx: entry.addedAtTx,
      is_active: true,
    });

    if (error && error.code !== '23505') throw error;
  }

  async removeWhitelistEntry(
    walletAddress: string,
    whitelistedAddress: string,
    removedAtBlock: number,
    removedAtTx: string
  ): Promise<void> {
    const { error } = await this.client
      .from('whitelist_entries')
      .update({
        is_active: false,
        removed_at_block: removedAtBlock,
        removed_at_tx: removedAtTx,
      })
      .eq('wallet_address', walletAddress.toLowerCase())
      .eq('whitelisted_address', whitelistedAddress.toLowerCase())
      .eq('is_active', true);

    if (error) throw error;
  }

  // ============================================
  // MODULE TRANSACTIONS
  // ============================================

  async addModuleTransaction(tx: ModuleTransaction): Promise<void> {
    const { error } = await this.client.from('module_transactions').insert({
      wallet_address: tx.walletAddress.toLowerCase(),
      module_type: tx.moduleType,
      module_address: tx.moduleAddress.toLowerCase(),
      to_address: tx.toAddress.toLowerCase(),
      value: tx.value,
      remaining_limit: tx.remainingLimit,
      executed_at_block: tx.executedAtBlock,
      executed_at_tx: tx.executedAtTx,
    });

    if (error) throw error;
  }

  // ============================================
  // DEPOSITS
  // ============================================

  async addDeposit(deposit: {
    walletAddress: string;
    senderAddress: string;
    amount: string;
    depositedAtBlock: number;
    depositedAtTx: string;
  }): Promise<void> {
    const { error } = await this.client.from('deposits').insert({
      wallet_address: deposit.walletAddress.toLowerCase(),
      sender_address: deposit.senderAddress.toLowerCase(),
      amount: deposit.amount,
      deposited_at_block: deposit.depositedAtBlock,
      deposited_at_tx: deposit.depositedAtTx,
    });

    if (error && error.code !== '23505') throw error; // Ignore duplicates
  }
}

export const supabase = new SupabaseService();
