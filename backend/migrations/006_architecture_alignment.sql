-- ============================================================
-- Migration 006: Architecture alignment
--
-- Ensures the schema matches the new architecture:
--   1. seats.status only uses 'available' and 'booked'
--      (no 'held' or 'locked' in PostgreSQL)
--   2. Order statuses aligned to new flow
--   3. Unique constraint on tickets(order_id, seat_id)
--      to prevent duplicate bookings
-- ============================================================

-- Update any lingering 'locked' or 'held' seats back to 'available'
-- (PostgreSQL should never have held/locked states)
UPDATE seats SET status = 'available' WHERE status NOT IN ('available', 'booked');

-- Update 'sold' seats to 'booked' (terminology alignment)
UPDATE seats SET status = 'booked' WHERE status = 'sold';

-- Add unique constraint to prevent duplicate seat bookings
-- (one ticket per seat per order)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_tickets_order_seat'
  ) THEN
    ALTER TABLE tickets ADD CONSTRAINT uq_tickets_order_seat UNIQUE (order_id, seat_id);
  END IF;
END $$;

-- Add unique constraint on order_items if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'order_items'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'uq_order_items_order_seat'
    ) THEN
      ALTER TABLE order_items ADD CONSTRAINT uq_order_items_order_seat UNIQUE (order_id, seat_id);
    END IF;
  END IF;
END $$;

-- Update provider from 'stripe' to 'razorpay' for future payments
ALTER TABLE payments ALTER COLUMN provider SET DEFAULT 'razorpay';
