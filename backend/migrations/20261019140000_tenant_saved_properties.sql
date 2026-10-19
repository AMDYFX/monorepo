-- Tenant saved properties (#1889).
-- One row per (user, listing) the tenant has saved. Saving twice is a no-op, so
-- the composite primary key is also the uniqueness guarantee the API relies on.

CREATE TABLE IF NOT EXISTS tenant_saved_properties (
    user_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, listing_id)
);

CREATE INDEX IF NOT EXISTS tenant_saved_properties_user_idx
    ON tenant_saved_properties (user_id);
