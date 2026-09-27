-- ============================================================
-- Migration 001: Initial schema
-- Creates every table from the design doc's data model.
-- Order matters: a table can only reference a table that
-- already exists, so parents (organizers, customers, venues)
-- are created before children (events, seats, orders...).
-- ============================================================

-- Organizers create events and own venues' events indirectly.
CREATE TABLE organizers (
    org_id SERIAL PRIMARY KEY,
    org_name VARCHAR(150) NOT NULL,
    org_email VARCHAR(150) UNIQUE NOT NULL,
    org_phone VARCHAR(20),
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- Customers browse and buy tickets.
CREATE TABLE customers (
    customer_id SERIAL PRIMARY KEY,
    customer_name VARCHAR(150) NOT NULL,
    customer_email VARCHAR(150) UNIQUE NOT NULL,
    phone_number VARCHAR(20),
    password_hash VARCHAR(255) NOT NULL,
    default_location VARCHAR(150), -- pre-fills the event search filter
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- Venues are reusable across many events. seat_layout_json is a
-- *template* (sections/rows/seat counts) — actual seat rows for
-- a specific event get generated from this template when the
-- organizer publishes that event (that's a later build step).
CREATE TABLE venues (
    venue_id SERIAL PRIMARY KEY,
    venue_name VARCHAR(150) NOT NULL,
    address VARCHAR(255),
    city VARCHAR(100),
    total_capacity INT,
    seat_layout_json JSONB,
    created_at TIMESTAMP DEFAULT now()
);

-- One event belongs to one organizer and happens at one venue.
CREATE TABLE events (
    event_id SERIAL PRIMARY KEY,
    org_id INT REFERENCES organizers(org_id),
    venue_id INT REFERENCES venues(venue_id),
    event_name VARCHAR(200) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    event_start_time TIMESTAMP NOT NULL,
    event_end_time TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'draft',
        -- draft / published / live / sold_out / closed
    sale_window_start TIMESTAMP, -- drives when the waiting room can activate
    sale_window_end TIMESTAMP,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- Seats are generated per event (from the venue template) once
-- the event is published. `version` is the field the optimistic
-- lock checks/increments on final sale — it's what guarantees a
-- seat can never be double-sold even if two payment confirmations
-- somehow race each other at the database level.
CREATE TABLE seats (
    seat_id SERIAL PRIMARY KEY,
    event_id INT REFERENCES events(event_id),
    section VARCHAR(50),
    row_label VARCHAR(10),
    seat_number INT,
    price DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'available',
        -- available / locked / sold
    version INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT now(),
    UNIQUE (event_id, section, row_label, seat_number)
);

-- An order is the "shopping cart" level object — one purchase
-- attempt, possibly for multiple seats. idempotency_key stops a
-- retried request (e.g. a flaky network) from creating a
-- duplicate order for the same checkout attempt.
CREATE TABLE orders (
    order_id SERIAL PRIMARY KEY,
    customer_id INT REFERENCES customers(customer_id),
    event_id INT REFERENCES events(event_id),
    status VARCHAR(20) DEFAULT 'pending',
        -- pending / confirmed / failed / expired
    total_amount DECIMAL(10,2) NOT NULL,
    idempotency_key VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

-- One row per purchased seat. Kept separate from orders (rather
-- than just an order_items count) so each individual ticket can
-- be scanned, checked in, or cancelled on its own.
CREATE TABLE tickets (
    ticket_id SERIAL PRIMARY KEY,
    order_id INT REFERENCES orders(order_id),
    seat_id INT REFERENCES seats(seat_id),
    price DECIMAL(10,2) NOT NULL,
    qr_code VARCHAR(255) UNIQUE,
    checked_in BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT now()
);

-- Kept separate from orders because one order can have several
-- payment attempts (a failed card, then a retry that succeeds) —
-- this table gives the Stripe webhook something reliable to
-- check for idempotency against.
CREATE TABLE payments (
    payment_id SERIAL PRIMARY KEY,
    order_id INT REFERENCES orders(order_id),
    provider VARCHAR(50) DEFAULT 'stripe',
    provider_payment_id VARCHAR(150),
    amount DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
        -- pending / succeeded / failed / refunded
    created_at TIMESTAMP DEFAULT now()
);

-- Helpful lookup indexes for the query patterns the design doc
-- describes (Section 9): listing events, loading a seat map,
-- and pulling a customer's order history are all frequent reads.
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_seats_event_id ON seats(event_id);
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_tickets_order_id ON tickets(order_id);