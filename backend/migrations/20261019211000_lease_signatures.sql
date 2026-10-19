-- Lease signing: persist the generated document hash and record per-party
-- signatures for the integrity + sign endpoints (#1960).

-- The lease_agreements table is created defensively here because it predates
-- the timestamped migration series.
CREATE TABLE IF NOT EXISTS lease_agreements (
  lease_id UUID PRIMARY KEY,
  deal_id UUID NOT NULL,
  document_key TEXT NOT NULL,
  document_hash TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  tenant_signed_at TIMESTAMPTZ,
  landlord_signed_at TIMESTAMPTZ,
  tenant_signature_ref TEXT,
  landlord_signature_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE lease_agreements ADD COLUMN IF NOT EXISTS document_hash TEXT;

CREATE INDEX IF NOT EXISTS lease_agreements_deal_id_idx
  ON lease_agreements (deal_id);

CREATE TABLE IF NOT EXISTS lease_signatures (
  signature_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL,
  lease_id UUID NOT NULL,
  signer_id TEXT NOT NULL,
  signer_role TEXT NOT NULL CHECK (signer_role IN ('tenant', 'landlord')),
  signer_name TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sign_date TEXT NOT NULL,
  document_hash TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  UNIQUE (deal_id, signer_role)
);

CREATE INDEX IF NOT EXISTS lease_signatures_deal_id_idx
  ON lease_signatures (deal_id);
