ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS isencrypted boolean NOT NULL DEFAULT false;
