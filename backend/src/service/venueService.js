// ============================================================
// venueService.js — Venue business logic
//
// Venues represent physical buildings (stadiums, halls, etc.)
// that are REUSABLE across many events. A venue is created once
// and can host unlimited events at different dates/times.
//
// The key data a venue holds:
//   - Basic info: name, address, city, total capacity
//   - seat_layout_json: a TEMPLATE describing the seating
//     structure (sections, rows, seats per row, default prices).
//     This template is NOT actual seats — real seat rows are
//     generated per event when the event is published (that's
//     what seatService.js does).
//
// This service provides:
//   1. createVenue — insert a new venue
//   2. getAllVenues — list all venues (for organizer dropdown)
//   3. getVenueById — get a single venue with full details
// ============================================================

const pool = require('../config/db');


// ============================================================
// createVenue({ name, address, cityId, totalCapacity, seatLayoutJson })
// ============================================================
// Creates a new venue record.
//
// `cityId` replaces the old free-text `city` field — it's a
// foreign key into the `cities` table (see migration 003), so
// the organizer picks a city from a dropdown on the frontend
// instead of typing it. Postgres will reject the INSERT with a
// foreign key violation if an invalid cityId is passed, which
// is exactly the safety net we want: it's impossible to create
// a venue in a city that doesn't exist in our system.
//
// The seatLayoutJson should follow this structure:
//   {
//     "sections": [
//       {
//         "name": "VIP",
//         "rows": ["A", "B"],
//         "seats_per_row": 10,
//         "default_price": 100
//       },
//       {
//         "name": "General",
//         "rows": ["C", "D", "E"],
//         "seats_per_row": 20,
//         "default_price": 50
//       }
//     ]
//   }
//
// The total_capacity is calculated automatically from the
// layout if not provided: sum of (rows × seats_per_row) for
// each section. This avoids the organizer having to manually
// count seats AND prevents mismatches between the layout and
// the stated capacity.
// ============================================================
async function createVenue({ name, address, cityId, totalCapacity, seatLayoutJson }) {
  // ----------------------------------------------------------
  // Auto-calculate total capacity from the layout if the
  // organizer didn't provide it. This way the capacity is
  // always consistent with the actual seat template.
  // ----------------------------------------------------------
  let capacity = totalCapacity;

  if (!capacity && seatLayoutJson && Array.isArray(seatLayoutJson.sections)) {
    capacity = seatLayoutJson.sections.reduce((total, section) => {
      return total + (section.rows.length * section.seats_per_row);
    }, 0);
  }

  // ----------------------------------------------------------
  // Insert the venue, then immediately JOIN back to `cities` in
  // the RETURNING step so the response includes the readable
  // city name/state, not just the raw city_id. This saves the
  // frontend a second round-trip just to display "Bangalore"
  // instead of "3" right after creating the venue.
  //
  // Postgres doesn't support joining inside a plain RETURNING
  // clause, so this is done as an INSERT ... RETURNING venue_id,
  // followed by a second SELECT that joins cities. Wrapped in a
  // single query via a CTE (WITH ... AS) keeps it to one
  // round-trip to the database instead of two separate queries.
  // ----------------------------------------------------------
  const result = await pool.query(
    `WITH inserted AS (
       INSERT INTO venues (venue_name, address, city_id, total_capacity, seat_layout_json)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING venue_id, venue_name, address, city_id, total_capacity, seat_layout_json, created_at
     )
     SELECT inserted.*, c.city_name, c.state
     FROM inserted
     JOIN cities c ON c.city_id = inserted.city_id`,
    [name, address || null, cityId || null, capacity || null, seatLayoutJson || null]
  );

  return result.rows[0];
}


// ============================================================
// getAllVenues()
// ============================================================
// Returns all venues, ordered by most recently created first.
//
// This is used when an organizer is creating an event and needs
// to pick a venue from a dropdown. We return basic info plus
// the seat layout so the frontend can preview the venue's
// sections before the organizer commits.
//
// JOINs to `cities` so the response includes a readable
// city_name/state instead of just the raw city_id — the
// frontend shouldn't have to separately fetch /api/cities and
// manually match IDs just to display where each venue is.
// ============================================================
async function getAllVenues() {
  const result = await pool.query(
    `SELECT v.venue_id, v.venue_name, v.address, v.total_capacity,
            v.seat_layout_json, v.created_at,
            c.city_id, c.city_name, c.state
     FROM venues v
     JOIN cities c ON c.city_id = v.city_id
     ORDER BY v.created_at DESC`
  );

  return result.rows;
}


// ============================================================
// getVenueById(venueId)
// ============================================================
// Returns a single venue by its ID, including the full
// seat_layout_json. Used when viewing venue details or when
// the seat generation logic needs the template.
//
// Throws if the venue doesn't exist — the controller will
// catch this and return a 404.
// ============================================================
async function getVenueById(venueId) {
  const result = await pool.query(
    `SELECT v.venue_id, v.venue_name, v.address, v.total_capacity,
            v.seat_layout_json, v.created_at,
            c.city_id, c.city_name, c.state
     FROM venues v
     JOIN cities c ON c.city_id = v.city_id
     WHERE v.venue_id = $1`,
    [venueId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Venue with ID ${venueId} not found`);
  }

  return result.rows[0];
}


module.exports = { createVenue, getAllVenues, getVenueById };
