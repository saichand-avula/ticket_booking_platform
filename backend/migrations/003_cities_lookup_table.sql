-- ============================================================
-- Migration 003: Cities lookup table + city_id foreign keys
--
-- CONTEXT:
-- Until now, "city" was stored as free-text (VARCHAR) on both
-- `venues` and `customers.default_location`. Free text is a
-- problem for filtering: "Bangalore", "bangalore", and
-- "Bengaluru" would all be treated as different cities even
-- though they mean the same place. It also makes a dropdown UI
-- impossible to build correctly — a dropdown needs a fixed,
-- known list of options, not arbitrary strings anyone could type.
--
-- THE FIX:
-- Introduce a `cities` table as the single source of truth for
-- "which cities exist in this system." Both venues and customers
-- now reference a city by its ID (a foreign key), not by typing
-- the name out. This guarantees:
--   - Every venue's city is a real, valid city (enforced by the
--     foreign key — you literally cannot insert a venue with a
--     city that doesn't exist in the cities table)
--   - Filtering "events in Bangalore" is an exact, fast integer
--     comparison (city_id = 3), not a fuzzy text match
--   - The frontend can populate a dropdown by simply calling
--     GET /api/cities and rendering the list — no guessing
--
-- WHY A SEPARATE TABLE INSTEAD OF AN ENUM/CHECK CONSTRAINT:
-- A Postgres ENUM or CHECK constraint would also restrict values
-- to a fixed list, but adding a new city later would require a
-- schema migration (ALTER TYPE / ALTER TABLE). With a real table,
-- adding a new city is just an INSERT — no migration, no
-- downtime, no redeploy. This matters because you explicitly
-- said "for now just a few metro cities" — implying more will
-- be added later.
-- ============================================================


-- ============================================================
-- TABLE: cities
-- ============================================================
-- A small, mostly-static lookup table. Seeded below with a
-- starter set of metro cities — more can be added later with a
-- simple INSERT, no migration required.
--
-- state is optional but useful for display (e.g. "Bangalore,
-- Karnataka" in a dropdown) and for potential future filtering
-- by state as well as city.
-- ============================================================
CREATE TABLE cities (
    city_id    SERIAL PRIMARY KEY,
    city_name  VARCHAR(100) NOT NULL UNIQUE,
    state      VARCHAR(100)
);

-- Seed data: a starting set of major metro cities.
-- UNIQUE on city_name means this is safe to re-run without
-- creating duplicates (a second run would just fail loudly on
-- the constraint instead of silently duplicating rows).
INSERT INTO cities (city_name, state) VALUES
    ('Bangalore', 'Karnataka'),
    ('Mumbai', 'Maharashtra'),
    ('Delhi', 'Delhi'),
    ('Hyderabad', 'Telangana'),
    ('Chennai', 'Tamil Nadu'),
    ('Kolkata', 'West Bengal'),
    ('Pune', 'Maharashtra'),
    ('Ahmedabad', 'Gujarat');


-- ============================================================
-- ALTER TABLE: venues
-- ============================================================
-- Replace the free-text `city` column with a `city_id` foreign
-- key pointing at the new cities table.
--
-- We add the new column, and drop the old text column — existing
-- venues (if any) would need their city_id set manually or via a
-- one-time data-fix query, since we can't automatically map a
-- free-text string like "Bangalore" to the right city_id without
-- knowing your existing data. For a fresh/dev database with no
-- real venues yet, this is a non-issue.
-- ============================================================
ALTER TABLE venues DROP COLUMN IF EXISTS city;
ALTER TABLE venues ADD COLUMN city_id INT REFERENCES cities(city_id);

-- Index for fast lookups/joins when filtering venues (and
-- therefore events) by city.
CREATE INDEX idx_venues_city_id ON venues(city_id);


-- ============================================================
-- ALTER TABLE: customers
-- ============================================================
-- Replace `default_location` (free text) with `default_city_id`
-- (foreign key). This is the customer's preferred/home city,
-- picked from the same dropdown at signup, used to pre-filter
-- the event listing by default.
-- ============================================================
ALTER TABLE customers DROP COLUMN IF EXISTS default_location;
ALTER TABLE customers ADD COLUMN default_city_id INT REFERENCES cities(city_id);

CREATE INDEX idx_customers_default_city_id ON customers(default_city_id);
