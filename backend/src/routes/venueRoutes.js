// ============================================================
// venueRoutes.js — Route definitions for venue endpoints
//
// All venue routes live under /api/venues (mounted in server.js).
//
// Routes:
//   POST /api/venues           → create a venue (organizer only)
//   GET  /api/venues           → list all venues (authenticated)
//   GET  /api/venues/:venueId  → get a venue by ID (authenticated)
//
// Authentication:
//   All routes require a valid JWT (authenticate middleware).
//   Creating a venue additionally requires the "organizer" role.
//   Viewing venues is allowed for any authenticated user.
// ============================================================

const express = require('express');
const router = express.Router();
const {
  createVenueHandler,
  listVenuesHandler,
  getVenueHandler,
} = require('../controllers/venueController');
const { authenticate, requireRole } = require('../middleware/authMiddleware');

// ----------------------------------------------------------
// POST /api/venues — Create a new venue
// Protected: must be logged in AND must be an organizer.
// ----------------------------------------------------------
router.post('/', authenticate, requireRole('organizer'), createVenueHandler);

// ----------------------------------------------------------
// GET /api/venues — List all venues
// Protected: must be logged in (any role).
// ----------------------------------------------------------
router.get('/', authenticate, listVenuesHandler);

// ----------------------------------------------------------
// GET /api/venues/:venueId — Get a specific venue
// Protected: must be logged in (any role).
// ----------------------------------------------------------
router.get('/:venueId', authenticate, getVenueHandler);

module.exports = router;
