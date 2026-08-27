-- Run this once against your EXISTING database to add support for
-- tracking your own brand's organic posts alongside KOL content.
-- (schema.sql was also updated to include this for any future fresh
-- installs, but that file alone won't touch a database that already
-- exists — this migration is what actually changes it.)

ALTER TABLE content ADD COLUMN source TEXT NOT NULL DEFAULT 'KOL';
