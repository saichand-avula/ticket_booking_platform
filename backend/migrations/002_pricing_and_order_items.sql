-- ============================================================
-- Migration 002: Event-specific pricing + order price snapshots
--
-- CONTEXT:
-- In migration 001, seats get their price from the venue's
-- seat_layout_json template at publish time. That means every
-- event at the same venue gets the same prices, and there's no
-- way for an organizer to change prices after publishing.
--
-- This migration adds two new tables to fix both problems:
--
--   1. event_section_pricing — the organizer's CURRENT price
--      per section, per event. This is the single source of
--      truth for "what does Section X cost RIGHT NOW." The
--      organizer can update this at any time, even mid-sale.
--
--   2. order_items — a frozen snapshot of the price at the
--      exact moment a customer starts checkout. This protects
--      already-placed orders from mid-sale price changes.
--      Example: customer buys at 12:00am for ₹12, organizer
--      changes price to ₹17 at 12:05am — the customer's
--      order_items row still says ₹12, and that's what goes
--      into their ticket.
--
-- EXISTING TABLES AFFECTED: NONE.
-- All eight tables from 001 (organizers, customers, venues,
-- events, seats, orders, tickets, payments) remain untouched.
-- The seats.price column still exists and still works — its
-- value is now populated from event_section_pricing instead
-- of directly from seat_layout_json, but the column itself
-- doesn't change.
-- ============================================================


-- ============================================================
-- TABLE: event_section_pricing
-- ============================================================
-- One row per section per event. Created at publish time (either
-- from the organizer's supplied prices or from the venue template's
-- default_price). The organizer can UPDATE these rows at any time
-- to change what future buyers will pay.
--
-- The composite primary key (event_id, section) guarantees each
-- section can only have one price row per event — no duplicates,
-- no ambiguity about "which price is current."
-- ============================================================
CREATE TABLE event_section_pricing (
    event_id  INT NOT NULL REFERENCES events(event_id),
    section   VARCHAR(50) NOT NULL,
    price     DECIMAL(10,2) NOT NULL,
    PRIMARY KEY (event_id, section)
);


-- ============================================================
-- TABLE: order_items
-- ============================================================
-- One row per seat per order. Created the instant a customer
-- hits "checkout" — NOT when the Stripe webhook fires later.
-- This timing is critical: if the organizer changes a section's
-- price between checkout-start and payment-confirmation, the
-- customer's price is already frozen here.
--
-- When the Stripe webhook eventually confirms payment, the
-- ticket rows are created with price copied from order_items,
-- NEVER re-read from seats.price. This is what guarantees:
--   "I clicked buy at ₹12, I pay ₹12, even if the organizer
--    changed the price to ₹17 two minutes later."
--
-- The UNIQUE constraint on (order_id, seat_id) prevents the
-- same seat from appearing twice in a single order — a sanity
-- check against application-level bugs.
-- ============================================================
CREATE TABLE order_items (
    order_item_id     SERIAL PRIMARY KEY,
    order_id          INT NOT NULL REFERENCES orders(order_id),
    seat_id           INT NOT NULL REFERENCES seats(seat_id),
    price_at_purchase DECIMAL(10,2) NOT NULL,
    UNIQUE (order_id, seat_id)
);


-- ============================================================
-- INDEXES
-- ============================================================
-- order_items will be queried by order_id when building the
-- confirmation page and when the Stripe webhook needs to know
-- what prices to write into tickets. This index makes that
-- lookup fast even for orders with many seats.
-- ============================================================
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
