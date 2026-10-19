-- Persistent account freeze state (#1948).
-- Replaces the in-memory userRiskStateStore, which lost every freeze on restart.
-- user_risk_state_events is append-only: one row per freeze/unfreeze/update.

CREATE TABLE IF NOT EXISTS user_risk_states (
    user_id TEXT PRIMARY KEY,
    is_frozen BOOLEAN NOT NULL DEFAULT FALSE,
    freeze_reason TEXT CHECK (freeze_reason IN ('NEGATIVE_BALANCE', 'MANUAL', 'COMPLIANCE')),
    notes TEXT,
    frozen_at TIMESTAMPTZ,
    frozen_by TEXT,
    unfrozen_at TIMESTAMPTZ,
    unfrozen_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_risk_states_frozen_idx
    ON user_risk_states (user_id)
    WHERE is_frozen = TRUE;

CREATE TABLE IF NOT EXISTS user_risk_state_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('FROZEN', 'UNFROZEN', 'UPDATED')),
    freeze_reason TEXT,
    notes TEXT,
    actor_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_risk_state_events_user_idx
    ON user_risk_state_events (user_id, created_at);
