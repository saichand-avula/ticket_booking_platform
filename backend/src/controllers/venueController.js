// ============================================================
// venueController.js — HTTP handlers for venue operations
//
// Endpoints:
//   POST /api/venues          → createVenue (organizer only)
//   GET  /api/venues          → listVenues (any authenticated user)
//   GET  /api/venues/:venueId → getVenue (any authenticated user)
//
// Only organizers can CREATE venues — customers have no reason
// to define physical buildings. But both customers and organizers
// can VIEW venues (a customer might want to see venue details
// on an event page).
// ============================================================

const { createVenue, getAllVenues, getVenueById } = require('../service/venueService');


// ============================================================
// createVenueHandler(req, res)
// ============================================================
// Creates a new venue. Only organizers should call this
// (enforced by requireRole('organizer') in the route definition).
//
// Expected request body:
//   {
//     "name": "Bangalore Indoor Stadium",
//     "address": "Kanteerava Complex",
//     "cityId": 1,                      ← required, from the /api/cities dropdown
//     "totalCapacity": 500,             ← optional (auto-calculated from layout)
//     "seatLayoutJson": {
//       "sections": [
//         { "name": "VIP", "rows": ["A","B"], "seats_per_row": 10, "default_price": 100 },
//         { "name": "General", "rows": ["C","D","E"], "seats_per_row": 20, "default_price": 50 }
//       ]
//     }
//   }
//
// NOTE: `cityId` replaces the old free-text `city` field. The
// frontend fetches GET /api/cities to populate a dropdown, and
// sends back the selected city's ID — the organizer never types
// a city name by hand anymore.
//
// Returns:
//   201 → the created venue object
//   400 → validation error
// ============================================================
async function createVenueHandler(req, res) {
  const { name, address, cityId, totalCapacity, seatLayoutJson } = req.body;

  // ----------------------------------------------------------
  // Validation: venue must have a name, a city, and a seat
  // layout. cityId is required (not optional like address) —
  // every venue needs to belong to a real city so that
  // location-based filtering works correctly downstream.
  // ----------------------------------------------------------
  if (!name) {
    return res.status(400).json({
      error: 'Missing required field: "name" is required.',
    });
  }

  if (!cityId) {
    return res.status(400).json({
      error: 'Missing required field: "cityId" is required. Fetch GET /api/cities to get valid options.',
    });
  }

  if (!seatLayoutJson || !seatLayoutJson.sections || !Array.isArray(seatLayoutJson.sections)) {
    return res.status(400).json({
      error: 'Missing or invalid "seatLayoutJson". Must include a "sections" array.',
    });
  }

  // ----------------------------------------------------------
  // Validate each section in the layout — every section must
  // have a name, a rows array, and a seats_per_row count.
  // default_price is optional here (the organizer can supply
  // event-specific prices when publishing).
  // ----------------------------------------------------------
  for (const section of seatLayoutJson.sections) {
    if (!section.name) {
      return res.status(400).json({
        error: 'Each section in seatLayoutJson must have a "name".',
      });
    }
    if (!Array.isArray(section.rows) || section.rows.length === 0) {
      return res.status(400).json({
        error: `Section "${section.name}" must have a non-empty "rows" array (e.g. ["A","B","C"]).`,
      });
    }
    if (!section.seats_per_row || section.seats_per_row < 1) {
      return res.status(400).json({
        error: `Section "${section.name}" must have a positive "seats_per_row" number.`,
      });
    }
  }

  try {
    const venue = await createVenue({ name, address, cityId, totalCapacity, seatLayoutJson });
    res.status(201).json(venue);
  } catch (err) {
    // Postgres foreign key violation (code 23503) means the
    // cityId sent doesn't actually exist in the cities table —
    // e.g. the frontend sent a stale/tampered ID. Translate this
    // into a clear message instead of a raw database error.
    if (err.code === '23503') {
      return res.status(400).json({
        error: 'Invalid cityId — that city does not exist. Fetch GET /api/cities to get valid options.',
      });
    }

    console.error('Failed to create venue:', err);
    res.status(400).json({ error: err.message });
  }
}


// ============================================================
// listVenuesHandler(req, res)
// ============================================================
// Returns all venues. Used when an organizer is creating an
// event and needs to pick a venue from a dropdown/list.
//
// Returns:
//   200 → array of venue objects
// ============================================================
async function listVenuesHandler(req, res) {
  try {
    const venues = await getAllVenues();
    res.json(venues);
  } catch (err) {
    console.error('Failed to list venues:', err);
    res.status(500).json({ error: 'Failed to retrieve venues.' });
  }
}


// ============================================================
// getVenueHandler(req, res)
// ============================================================
// Returns a single venue by ID, including its full seat layout.
//
// Returns:
//   200 → venue object
//   404 → venue not found
// ============================================================
async function getVenueHandler(req, res) {
  const { venueId } = req.params;

  try {
    const venue = await getVenueById(venueId);
    res.json(venue);
  } catch (err) {
    // The service throws if the venue doesn't exist.
    // We return 404 instead of a generic 400.
    res.status(404).json({ error: err.message });
  }
}


module.exports = {
  createVenueHandler,
  listVenuesHandler,
  getVenueHandler,
};
