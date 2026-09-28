// ============================================================
// cityController.js — HTTP handler for city lookups
//
// Endpoint:
//   GET /api/cities → list all cities, for populating dropdowns
//
// This is deliberately NOT behind authentication — the signup
// page needs the city dropdown BEFORE a user has an account or
// a token, so this must be a public endpoint. Contrast this with
// /api/venues, which requires login, because venues are only
// browsed by already-authenticated users picking a venue for an
// event.
// ============================================================

const { getAllCities } = require('../service/cityService');


// ============================================================
// listCitiesHandler(req, res)
// ============================================================
// Returns the full list of cities.
//
// Returns:
//   200 → array of { city_id, city_name, state }
// ============================================================
async function listCitiesHandler(req, res) {
  try {
    const cities = await getAllCities();
    res.json(cities);
  } catch (err) {
    console.error('Failed to list cities:', err);
    res.status(500).json({ error: 'Failed to retrieve cities.' });
  }
}


module.exports = { listCitiesHandler };