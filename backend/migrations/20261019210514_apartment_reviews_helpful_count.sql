-- Add helpful_count column to apartment_reviews
ALTER TABLE apartment_reviews
ADD COLUMN IF NOT EXISTS helpful_count INTEGER NOT NULL DEFAULT 0;
