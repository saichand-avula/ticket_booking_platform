-- ============================================================
-- Migration 004: Add buffer hours columns to events table
--
-- CONTEXT:
-- Buffer hours (setup/teardown time before and after an event)
-- were previously only used at creation time for the venue
-- conflict check, but never stored. This meant:
--   1. The organizer couldn't see what buffer they originally set
--   2. The buffer couldn't be edited after event creation
--   3. Future conflict re-checks (e.g., when editing event times)
--      wouldn't know the original buffer values
--
-- THE FIX:
-- Add two new columns to persist the buffer values:
--   - buffer_hours_before (default 2)
--   - buffer_hours_after  (default 2)
-- ============================================================

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS buffer_hours_before NUMERIC(4,1) DEFAULT 2,
  ADD COLUMN IF NOT EXISTS buffer_hours_after  NUMERIC(4,1) DEFAULT 2;
