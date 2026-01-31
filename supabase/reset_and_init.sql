-- ============================================
-- Quai Multisig Indexer - Database Reset & Initialize
-- WARNING: This will DELETE ALL DATA
-- Run this in Supabase SQL Editor to reset the database
-- ============================================

-- ============================================
-- PART 1: DROP EVERYTHING
-- ============================================

-- Drop all tables (in order respecting foreign key constraints)
DROP TABLE IF EXISTS social_recovery_approvals CASCADE;
DROP TABLE IF EXISTS social_recoveries CASCADE;
DROP TABLE IF EXISTS social_recovery_guardians CASCADE;
DROP TABLE IF EXISTS social_recovery_configs CASCADE;
DROP TABLE IF EXISTS module_transactions CASCADE;
DROP TABLE IF EXISTS whitelist_entries CASCADE;
DROP TABLE IF EXISTS daily_limit_state CASCADE;
DROP TABLE IF EXISTS deposits CASCADE;
DROP TABLE IF EXISTS wallet_modules CASCADE;
DROP TABLE IF EXISTS confirmations CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS wallet_owners CASCADE;
DROP TABLE IF EXISTS wallets CASCADE;
DROP TABLE IF EXISTS indexer_state CASCADE;

-- Drop all functions
DROP FUNCTION IF EXISTS update_updated_at() CASCADE;
DROP FUNCTION IF EXISTS update_confirmation_count() CASCADE;
DROP FUNCTION IF EXISTS update_recovery_approval_count() CASCADE;
DROP FUNCTION IF EXISTS increment_owner_count(TEXT, INTEGER) CASCADE;

-- ============================================
-- PART 2: CREATE SCHEMA
-- ============================================

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

-- Multisig transactions (uses bytes32 tx_hash from contract)
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    tx_hash TEXT NOT NULL,
    to_address TEXT NOT NULL,
    value TEXT NOT NULL,
    data TEXT,
    transaction_type TEXT NOT NULL DEFAULT 'unknown',
    decoded_params JSONB,
    status TEXT NOT NULL DEFAULT 'pending',
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
    UNIQUE(wallet_address, tx_hash)
);

-- Transaction confirmations
CREATE TABLE confirmations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    confirmed_at_block BIGINT NOT NULL,
    confirmed_at_tx TEXT NOT NULL,
    revoked_at_block BIGINT,
    revoked_at_tx TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (wallet_address, tx_hash)
        REFERENCES transactions(wallet_address, tx_hash) ON DELETE CASCADE,
    UNIQUE(wallet_address, tx_hash, owner_address, confirmed_at_block)
);

-- Wallet modules (enabled/disabled modules per wallet)
CREATE TABLE wallet_modules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    module_address TEXT NOT NULL,
    enabled_at_block BIGINT NOT NULL,
    enabled_at_tx TEXT NOT NULL,
    disabled_at_block BIGINT,
    disabled_at_tx TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wallet_address, module_address)
);

-- Deposits (QUAI received by wallets)
CREATE TABLE deposits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    sender_address TEXT NOT NULL,
    amount TEXT NOT NULL,
    deposited_at_block BIGINT NOT NULL,
    deposited_at_tx TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wallet_address, deposited_at_tx)
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
-- MODULE TABLES
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

-- Whitelist module entries
CREATE TABLE whitelist_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    whitelisted_address TEXT NOT NULL,
    limit_amount TEXT,
    added_at_block BIGINT NOT NULL,
    added_at_tx TEXT,
    removed_at_block BIGINT,
    removed_at_tx TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wallet_address, whitelisted_address, added_at_block)
);

-- Module transactions (daily limit and whitelist bypasses)
CREATE TABLE module_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    module_type TEXT NOT NULL,
    module_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    value TEXT NOT NULL,
    remaining_limit TEXT,
    executed_at_block BIGINT NOT NULL,
    executed_at_tx TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- SOCIAL RECOVERY MODULE TABLES
-- ============================================

-- Recovery configuration per wallet
CREATE TABLE social_recovery_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    threshold INTEGER NOT NULL,
    recovery_period BIGINT NOT NULL,
    setup_at_block BIGINT NOT NULL,
    setup_at_tx TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wallet_address)
);

-- Guardians for social recovery
CREATE TABLE social_recovery_guardians (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    guardian_address TEXT NOT NULL,
    added_at_block BIGINT NOT NULL,
    added_at_tx TEXT NOT NULL,
    removed_at_block BIGINT,
    removed_at_tx TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wallet_address, guardian_address, added_at_block)
);

-- Recovery requests (pending, executed, cancelled)
CREATE TABLE social_recoveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    recovery_hash TEXT NOT NULL,
    new_owners TEXT[] NOT NULL,
    new_threshold INTEGER NOT NULL,
    initiator_address TEXT NOT NULL,
    approval_count INTEGER DEFAULT 0,
    required_threshold INTEGER NOT NULL,
    execution_time BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    initiated_at_block BIGINT NOT NULL,
    initiated_at_tx TEXT NOT NULL,
    executed_at_block BIGINT,
    executed_at_tx TEXT,
    cancelled_at_block BIGINT,
    cancelled_at_tx TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wallet_address, recovery_hash)
);

-- Guardian approvals for recoveries
CREATE TABLE social_recovery_approvals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL,
    recovery_hash TEXT NOT NULL,
    guardian_address TEXT NOT NULL,
    approved_at_block BIGINT NOT NULL,
    approved_at_tx TEXT NOT NULL,
    revoked_at_block BIGINT,
    revoked_at_tx TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (wallet_address, recovery_hash)
        REFERENCES social_recoveries(wallet_address, recovery_hash) ON DELETE CASCADE,
    UNIQUE(wallet_address, recovery_hash, guardian_address, approved_at_block)
);

-- ============================================
-- INDEXES
-- ============================================

-- Core table indexes
CREATE INDEX idx_wallet_owners_wallet ON wallet_owners(wallet_address);
CREATE INDEX idx_wallet_owners_active ON wallet_owners(wallet_address) WHERE is_active = TRUE;
CREATE INDEX idx_transactions_wallet ON transactions(wallet_address);
CREATE INDEX idx_transactions_wallet_txhash ON transactions(wallet_address, tx_hash);
CREATE INDEX idx_transactions_status ON transactions(wallet_address, status);
CREATE INDEX idx_transactions_pending ON transactions(wallet_address) WHERE status = 'pending';
CREATE INDEX idx_transactions_type ON transactions(wallet_address, transaction_type);
CREATE INDEX idx_confirmations_wallet_txhash ON confirmations(wallet_address, tx_hash);
CREATE INDEX idx_confirmations_active ON confirmations(wallet_address, tx_hash) WHERE is_active = TRUE;
CREATE INDEX idx_wallet_modules_active ON wallet_modules(wallet_address) WHERE is_active = TRUE;

-- Deposits indexes
CREATE INDEX idx_deposits_wallet ON deposits(wallet_address);
CREATE INDEX idx_deposits_sender ON deposits(sender_address);
CREATE INDEX idx_deposits_block ON deposits(deposited_at_block);
CREATE INDEX idx_deposits_created ON deposits(created_at DESC);

-- Module transactions indexes
CREATE INDEX idx_module_transactions_wallet ON module_transactions(wallet_address);
CREATE INDEX idx_module_transactions_type ON module_transactions(module_type);
CREATE INDEX idx_module_transactions_block ON module_transactions(executed_at_block);

-- Social Recovery indexes
CREATE INDEX idx_social_recovery_configs_wallet ON social_recovery_configs(wallet_address);
CREATE INDEX idx_social_recovery_guardians_wallet ON social_recovery_guardians(wallet_address);
CREATE INDEX idx_social_recovery_guardians_active ON social_recovery_guardians(wallet_address) WHERE is_active = TRUE;
CREATE INDEX idx_social_recoveries_wallet ON social_recoveries(wallet_address);
CREATE INDEX idx_social_recoveries_pending ON social_recoveries(wallet_address) WHERE status = 'pending';
CREATE INDEX idx_social_recoveries_hash ON social_recoveries(recovery_hash);
CREATE INDEX idx_social_recovery_approvals_recovery ON social_recovery_approvals(wallet_address, recovery_hash);
CREATE INDEX idx_recovery_approvals_active_count ON social_recovery_approvals(wallet_address, recovery_hash) WHERE is_active = TRUE;

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Update confirmation count trigger
CREATE OR REPLACE FUNCTION update_confirmation_count()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE transactions SET
        confirmation_count = (
            SELECT COUNT(*) FROM confirmations
            WHERE wallet_address = NEW.wallet_address
            AND tx_hash = NEW.tx_hash
            AND is_active = TRUE
        ),
        updated_at = NOW()
    WHERE wallet_address = NEW.wallet_address
    AND tx_hash = NEW.tx_hash;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_confirmation_count
AFTER INSERT OR UPDATE ON confirmations
FOR EACH ROW EXECUTE FUNCTION update_confirmation_count();

CREATE TRIGGER trigger_wallets_updated_at
BEFORE UPDATE ON wallets
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_transactions_updated_at
BEFORE UPDATE ON transactions
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Update recovery approval count trigger
CREATE OR REPLACE FUNCTION update_recovery_approval_count()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE social_recoveries
    SET
        approval_count = (
            SELECT COUNT(*) FROM social_recovery_approvals
            WHERE wallet_address = NEW.wallet_address
            AND recovery_hash = NEW.recovery_hash
            AND is_active = TRUE
        ),
        updated_at = NOW()
    WHERE wallet_address = NEW.wallet_address
    AND recovery_hash = NEW.recovery_hash;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_recovery_approval_count
AFTER INSERT OR UPDATE ON social_recovery_approvals
FOR EACH ROW EXECUTE FUNCTION update_recovery_approval_count();

CREATE TRIGGER trigger_social_recoveries_updated_at
BEFORE UPDATE ON social_recoveries
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Atomic owner count update function
CREATE OR REPLACE FUNCTION increment_owner_count(
    wallet_addr TEXT,
    delta_value INTEGER
)
RETURNS void AS $$
BEGIN
    UPDATE wallets
    SET owner_count = owner_count + delta_value,
        updated_at = NOW()
    WHERE address = wallet_addr;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

-- Enable RLS on all tables
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_limit_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE whitelist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_recovery_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_recovery_guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_recovery_approvals ENABLE ROW LEVEL SECURITY;

-- Public read access (anyone can read)
CREATE POLICY "Public read access" ON wallets FOR SELECT USING (true);
CREATE POLICY "Public read access" ON wallet_owners FOR SELECT USING (true);
CREATE POLICY "Public read access" ON transactions FOR SELECT USING (true);
CREATE POLICY "Public read access" ON confirmations FOR SELECT USING (true);
CREATE POLICY "Public read access" ON wallet_modules FOR SELECT USING (true);
CREATE POLICY "Public read access" ON deposits FOR SELECT USING (true);
CREATE POLICY "Public read access" ON daily_limit_state FOR SELECT USING (true);
CREATE POLICY "Public read access" ON whitelist_entries FOR SELECT USING (true);
CREATE POLICY "Public read access" ON module_transactions FOR SELECT USING (true);
CREATE POLICY "Public read access" ON social_recovery_configs FOR SELECT USING (true);
CREATE POLICY "Public read access" ON social_recovery_guardians FOR SELECT USING (true);
CREATE POLICY "Public read access" ON social_recoveries FOR SELECT USING (true);
CREATE POLICY "Public read access" ON social_recovery_approvals FOR SELECT USING (true);

-- Service role write access (only indexer can write)
CREATE POLICY "Service write access" ON wallets FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON wallet_owners FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON transactions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON confirmations FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON wallet_modules FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON deposits FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON daily_limit_state FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON whitelist_entries FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON module_transactions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON social_recovery_configs FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON social_recovery_guardians FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON social_recoveries FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write access" ON social_recovery_approvals FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- REALTIME SUPPORT
-- ============================================

ALTER PUBLICATION supabase_realtime ADD TABLE wallets;
ALTER PUBLICATION supabase_realtime ADD TABLE wallet_owners;
ALTER PUBLICATION supabase_realtime ADD TABLE transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE confirmations;
ALTER PUBLICATION supabase_realtime ADD TABLE wallet_modules;
ALTER PUBLICATION supabase_realtime ADD TABLE deposits;
ALTER PUBLICATION supabase_realtime ADD TABLE module_transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE social_recovery_configs;
ALTER PUBLICATION supabase_realtime ADD TABLE social_recovery_guardians;
ALTER PUBLICATION supabase_realtime ADD TABLE social_recoveries;
ALTER PUBLICATION supabase_realtime ADD TABLE social_recovery_approvals;
