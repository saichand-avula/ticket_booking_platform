// ============================================================
// eventController.js — HTTP handlers for event-related actions
//
// This file stays thin on purpose — it validates the request,
// calls into the service layer, and sends the response. Actual
// business logic (SQL, pricing resolution, transaction handling)
// lives in the services, not here.
//
// Endpoints handled:
//   POST   /api/events                  → createEventHandler  (create draft)
//   GET    /api/events                  → listEventsHandler   (list with filters)
//   GET    /api/events/:eventId         → getEventHandler     (single event detail)
//   POST   /api/events/:eventId/publish → publishEvent        (generate seats)
//   PATCH  /api/events/:eventId/pricing → updateSectionPricing (change section price)
// ============================================================

const { generateSeatsForEvent, updateSectionPrice } = require('../service/seatService');
const { createEvent, getAllEvents, getEventById, updateEvent } = require('../service/eventService');
const { initializeEventSeats } = require('../service/redisInventoryService');
const pool = require('../config/db');


// ============================================================
// publishEvent(req, res)
// ============================================================
// Called when an organizer publishes an event. This triggers
// seat generation from the venue template and writes the initial
// section prices.
//
// The request body can optionally include sectionPricing:
//   {
//     "sectionPricing": {
//       "VIP": 200,
//       "General": 75
//     }
//   }
//
// If sectionPricing is omitted (or partially filled), the seat
// generation logic falls back to the venue template's
// default_price for any missing sections. This means organizers
// can:
//   - Supply all prices explicitly (full control)
//   - Supply some prices (override specific sections only)
//   - Supply nothing (use all venue defaults)
// ============================================================
async function publishEvent(req, res) {
  const { eventId } = req.params;

  // sectionPricing is optional — if the organizer doesn't send
  // it, we default to an empty object and the service layer
  // will use venue template defaults for every section.
  const { sectionPricing = {} } = req.body || {};

  try {
    // ----------------------------------------------------------
    // Validate: sale_window_start must be set before publishing.
    // Without it the waiting room doesn't know when to open
    // ticket sales, so we block publishing until it's filled in.
    // ----------------------------------------------------------
    const eventData = await getEventById(eventId);

    if (!eventData.sale_window_start) {
      return res.status(400).json({
        error: 'Cannot publish: "Sale Window Start" must be set first. Edit the event to add a sale start date.',
      });
    }

    const result = await generateSeatsForEvent(eventId, sectionPricing);

    // ---- Initialize Redis seat inventory ----
    // After seats are created in PostgreSQL, populate Redis
    // with the initial AVAILABLE/BOOKED state for every seat.
    const allSeats = await pool.query(
      `SELECT seat_id, status FROM seats WHERE event_id = $1`,
      [eventId]
    );
    await initializeEventSeats(eventId, allSeats.rows);

    res.json({
      message: 'Event published and seats generated',
      seatsCreated: result.seatsCreated,
    });
  } catch (err) {
    console.error('Failed to publish event:', err);
    res.status(400).json({ error: err.message });
  }
}


// ============================================================
// updateSectionPricing(req, res)
// ============================================================
// Called when an organizer changes a section's ticket price,
// which can happen at any time — even after sales have started.
//
// Request body:
//   {
//     "section": "VIP",
//     "price": 170
//   }
//
// What happens:
//   - event_section_pricing is updated (authoritative record)
//   - All unsold seats in that section get the new price
//   - Already-sold seats are untouched
//   - Already-placed orders are protected by order_items
//     (price was frozen at checkout time, not read again)
//
// Validation:
//   - section must be provided and non-empty
//   - price must be a positive number
//   - The section must actually exist for this event
//     (the service layer will throw if it doesn't)
// ============================================================
async function updateSectionPricing(req, res) {
  const { eventId } = req.params;
  const { section, price } = req.body;

  // ----------------------------------------------------------
  // Basic input validation — catch obvious mistakes here in
  // the controller rather than letting them propagate into SQL
  // errors deeper in the stack.
  // ----------------------------------------------------------
  if (!section || typeof section !== 'string') {
    return res.status(400).json({
      error: 'Missing or invalid "section" — must be a non-empty string (e.g. "VIP").',
    });
  }

  if (price === undefined || price === null || isNaN(price) || parseFloat(price) <= 0) {
    return res.status(400).json({
      error: 'Missing or invalid "price" — must be a positive number.',
    });
  }

  try {
    const result = await updateSectionPrice(eventId, section, parseFloat(price));
    res.json({
      message: `Price updated for section "${result.sectionUpdated}"`,
      newPrice: result.newPrice,
      seatsUpdated: result.seatsUpdated,
    });
  } catch (err) {
    console.error('Failed to update section pricing:', err);
    res.status(400).json({ error: err.message });
  }
}


// ============================================================
// createEventHandler(req, res)
// ============================================================
// Creates a new event in 'draft' status. The event is not
// visible to customers yet and has no seats — those are
// generated later when the organizer calls /publish.
//
// The organizer's ID comes from the JWT token (req.user.id),
// NOT from the request body. This prevents an organizer from
// creating events under someone else's account.
//
// Expected request body:
//   {
//     "venueId": 3,
//     "name": "Rock Concert 2026",
//     "description": "An amazing night of rock music",   ← optional
//     "category": "Music",                               ← optional
//     "startTime": "2026-09-15T19:00:00",
//     "endTime": "2026-09-15T23:00:00",
//     "saleWindowStart": "2026-09-01T10:00:00",          ← optional
//     "saleWindowEnd": "2026-09-15T18:00:00"             ← optional
//   }
//
// Returns:
//   201 → the created event object (status = 'draft')
//   400 → validation error
// ============================================================
async function createEventHandler(req, res) {
  const { venueId, name, description, category,
    startTime, endTime, saleWindowStart, saleWindowEnd,
    bufferHoursBefore, bufferHoursAfter } = req.body;

  // ----------------------------------------------------------
  // Validation: the minimum required fields to create an event.
  // ----------------------------------------------------------
  if (!venueId) {
    return res.status(400).json({
      error: 'Missing required field: "venueId" — which venue is this event at?',
    });
  }

  if (!name) {
    return res.status(400).json({
      error: 'Missing required field: "name" — what is this event called?',
    });
  }

  if (!startTime || !endTime) {
    return res.status(400).json({
      error: 'Missing required fields: "startTime" and "endTime" are both required.',
    });
  }

  // ----------------------------------------------------------
  // Validate that the event doesn't end before it starts.
  // This is a common mistake and would cause confusing issues
  // later (e.g., the event appearing as "closed" immediately).
  // ----------------------------------------------------------
  if (new Date(endTime) <= new Date(startTime)) {
    return res.status(400).json({
      error: '"endTime" must be after "startTime".',
    });
  }

  try {
    // The organizer's ID comes from the JWT, not the body.
    // req.user.id is set by the authenticate middleware.
    const event = await createEvent({
      orgId: req.user.id,
      venueId,
      name,
      description,
      category,
      startTime,
      endTime,
      saleWindowStart,
      saleWindowEnd,
      bufferHoursBefore: bufferHoursBefore !== undefined ? parseFloat(bufferHoursBefore) : 2,
      bufferHoursAfter: bufferHoursAfter !== undefined ? parseFloat(bufferHoursAfter) : 2,
    });

    // 201 Created — a new resource was successfully created.
    res.status(201).json(event);
  } catch (err) {
    console.error('Failed to create event:', err);
    res.status(400).json({ error: err.message });
  }
}


// ============================================================
// listEventsHandler(req, res)
// ============================================================
// Returns a list of events with optional filtering.
//
// Query parameters (all optional):
//   ?status=published  → only show published events
//   ?cityId=3          → only show events in that city (its ID)
//   ?cityId=all        → explicitly show events in every city
//   ?category=Music    → only show music events
//
// `cityId` replaces the old free-text `city` param — it's now
// an exact match against the venue's city_id (see migration 003
// and eventService.getAllEvents for the full reasoning). The
// frontend's customer dashboard defaults this to the logged-in
// customer's own default_city_id (returned at login/signup), and
// switches to "all" or another city's ID when the customer
// changes the dropdown.
//
// For organizers viewing their own dashboard, the route can
// pass orgId from req.user.id to show only their events
// (including drafts). For customers, only published/live
// events are shown.
//
// Returns:
//   200 → array of event objects (with venue name and city name)
// ============================================================
async function listEventsHandler(req, res) {
  const { status, cityId, category, myEvents } = req.query;

  try {
    // ----------------------------------------------------------
    // Build the filters object from query parameters.
    // Only include a filter if it was actually provided —
    // undefined values are ignored by the service layer.
    // Note: cityId is passed through as-is (including the
    // literal string "all") — getAllEvents() handles the "all"
    // case by skipping the city filter entirely.
    // ----------------------------------------------------------
    const filters = {};
    if (status) filters.status = status;
    if (cityId) filters.cityId = cityId;
    if (category) filters.category = category;

    // ----------------------------------------------------------
    // If ?myEvents=true is passed AND the user is an organizer,
    // automatically filter to only their events. The orgId comes
    // from the JWT (req.user.id), NOT from the query string —
    // this prevents organizers from viewing other organizers'
    // events by guessing an ID.
    // ----------------------------------------------------------
    if (myEvents === 'true' && req.user && req.user.role === 'organizer') {
      filters.orgId = req.user.id;
    }

    const events = await getAllEvents(filters);
    res.json(events);
  } catch (err) {
    console.error('Failed to list events:', err);
    res.status(500).json({ error: 'Failed to retrieve events.' });
  }
}


// ============================================================
// getEventHandler(req, res)
// ============================================================
// Returns a single event by ID with full details, including:
//   - Event info (name, description, times, status)
//   - Venue info (name, address, city, capacity)
//   - Organizer name
//   - Section pricing (if event is published)
//
// This powers the event detail page that customers see before
// buying tickets.
//
// Returns:
//   200 → event object with nested venue + pricing data
//   404 → event not found
// ============================================================
async function getEventHandler(req, res) {
  const { eventId } = req.params;

  try {
    const event = await getEventById(eventId);
    res.json(event);
  } catch (err) {
    // The service throws if the event doesn't exist.
    res.status(404).json({ error: err.message });
  }
}


// ============================================================
// updateEventHandler(req, res)
// ============================================================
// Updates editable fields on an event.
//
// PATCH /api/events/:eventId
//
// Request body (all optional — only include what you want to change):
//   {
//     "name": "New Event Name",
//     "description": "Updated description",
//     "category": "Music",
//     "startTime": "2026-12-01T10:00",
//     "endTime": "2026-12-01T18:00",
//     "saleWindowStart": "2026-11-15T00:00",
//     "saleWindowEnd": "2026-12-01T09:00"
//   }
//
// Security: The organizer's ID comes from the JWT. Only the
// event's owner can edit it.
// ============================================================
async function updateEventHandler(req, res) {
  const { eventId } = req.params;
  const updates = req.body;

  try {
    const updated = await updateEvent(eventId, req.user.id, updates);
    res.json(updated);
  } catch (err) {
    console.error('Failed to update event:', err);
    res.status(400).json({ error: err.message });
  }
}


module.exports = {
  createEventHandler,
  listEventsHandler,
  getEventHandler,
  updateEventHandler,
  publishEvent,
  updateSectionPricing,
};