// ============================================================
// cityService.js — City lookup business logic
//
// Cities are a small, mostly-static reference table (see
// migration 003). This service has exactly one job: fetch the
// list of cities so the frontend can render a dropdown.
//
// WHY THIS EXISTS AS ITS OWN SERVICE (not folded into venueService
// or a one-off query somewhere):
//   Both venue creation (organizer picks a city) AND customer
//   signup (customer picks their home city) AND the event listing
//   filter (customer picks a city to filter by) all need the same
//   "list of valid cities." Centralizing it here means all three
//   places call the exact same function instead of three slightly
//   different copies of the same query drifting apart over time.
// ============================================================

const pool = require('../config/db');


// ============================================================
// getAllCities()
// ============================================================
// Returns every city in the lookup table, alphabetically by
// name — the natural order for a dropdown (easy for a human to
// scan, rather than insertion order which is arbitrary).
// ============================================================
async function getAllCities() {
    const result = await pool.query(
        `SELECT city_id, city_name, state
     FROM cities
     ORDER BY city_name ASC`
    );

    return result.rows;
}


module.exports = { getAllCities };