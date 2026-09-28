// ============================================================
// eventRoutes.js — Route definitions for event endpoints
//
// All event routes live under /api/events (mounted in server.js).
//
// Routes:
//   POST  /api/events                    → create a new event (draft)
//   GET   /api/events                    → list events (with optional filters)
//   GET   /api/events/:eventId           → get a single event's details
//   PATCH /api/events/:eventId           → update event details (name, dates, etc.)
//   POST  /api/events/:eventId/publish   → publish event & generate seats
//   PATCH /api/events/:eventId/pricing   → update a section's price
//
// Authentication & Authorization:
//   - Creating events, publishing, and updating prices require
//     the organizer role (they own the events).
//   - Listing and viewing events is open to any authenticated
//     user (customers browse events here).
//
// IMPORTANT — Route order matters in Express:
//   Specific routes (like /:eventId/publish) must come AFTER
//   their parent parameter route (/:eventId) or they won't
//   match correctly. Express evaluates routes in the order
//   they're defined.
// ============================================================

const express = require('express');
const router = express.Router();
const {
  createEventHandler,
  listEventsHandler,
  getEventHandler,
  updateEventHandler,
  publishEvent,
  updateSectionPricing,
} = require('../controllers/eventController');
const { authenticate, requireRole } = require('../middleware/authMiddleware');

// ----------------------------------------------------------
// POST /api/events — Create a new event (draft)
// Protected: must be logged in as an organizer.
// Body: { venueId, name, startTime, endTime, ... }
// ----------------------------------------------------------
router.post('/', authenticate, requireRole('organizer'), createEventHandler);

// ----------------------------------------------------------
// GET /api/events — List events
// Protected: must be logged in (any role).
// Query params: ?status=published&city=Bangalore&category=Music
// ----------------------------------------------------------
router.get('/', authenticate, listEventsHandler);

// ----------------------------------------------------------
// GET /api/events/:eventId — Get a single event's details
// Protected: must be logged in (any role).
// Returns: event + venue info + section pricing
// ----------------------------------------------------------
router.get('/:eventId', authenticate, getEventHandler);

// ----------------------------------------------------------
// PATCH /api/events/:eventId — Update event details
// Protected: must be logged in as an organizer.
// Only the event's owner can edit it (verified in service layer).
// Body: { name?, description?, category?, startTime?, endTime?,
//         saleWindowStart?, saleWindowEnd? }
// ----------------------------------------------------------
router.patch('/:eventId', authenticate, requireRole('organizer'), updateEventHandler);

// ----------------------------------------------------------
// POST /api/events/:eventId/publish — Publish event
// Protected: must be logged in as an organizer.
// This generates seat rows and writes initial section pricing.
// Body (optional): { sectionPricing: { "VIP": 200, ... } }
// ----------------------------------------------------------
router.post('/:eventId/publish', authenticate, requireRole('organizer'), publishEvent);

// ----------------------------------------------------------
// PATCH /api/events/:eventId/pricing — Update section price
// Protected: must be logged in as an organizer.
// Body: { section: "VIP", price: 170 }
// ----------------------------------------------------------
router.patch('/:eventId/pricing', authenticate, requireRole('organizer'), updateSectionPricing);

module.exports = router;