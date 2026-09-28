// ============================================================
// eventService.js — Event business logic
//
// Events are the core entity in the system — a concert, a
// sports match, a conference, etc. Each event:
//   - Belongs to one organizer (org_id)
//   - Takes place at one venue (venue_id)
//   - Has a lifecycle: draft → published → live → sold_out → closed
//
// This service handles:
//   1. createEvent — insert a new event in 'draft' status
//   2. getAllEvents — list events (with optional filters)
//   3. getEventById — get a single event with full details
//
// NOTE: Publishing (draft → published) and pricing are handled
// by seatService.js, not here. This service only deals with
// basic CRUD — creating the event record, listing, and viewing.
// ============================================================

const pool = require('../config/db');


// ============================================================
// createEvent({ orgId, venueId, name, description, category,
//               startTime, endTime, saleWindowStart, saleWindowEnd,
//               bufferHoursBefore, bufferHoursAfter })
// ============================================================
// Creates a new event in 'draft' status.
//
// A draft event:
//   - Is NOT visible to customers yet
//   - Has NO seats generated (that happens at publish time)
//   - Can be edited freely before publishing
//
// VENUE CONFLICT CHECK:
//   Before creating the event, we check if the venue is already
//   booked during the requested time window. The organizer can
//   specify buffer hours before and after the event (e.g., 2 hours
//   before for setup, 2 hours after for teardown). If another
//   event's time window (including ITS buffer) overlaps with this
//   event's window (including THIS buffer), the creation is rejected.
//
//   Example: Event A runs 4pm-10pm with 2hr buffer → venue is
//   blocked 2pm-12am. If Event B tries to book 11pm-1am with 1hr
//   buffer (so 10pm-2am), it would overlap with Event A's block
//   and be rejected.
//
// The orgId comes from req.user.id (the authenticated organizer),
// NOT from the request body. This prevents an organizer from
// creating events under someone else's account.
// ============================================================
async function createEvent({ orgId, venueId, name, description, category,
  startTime, endTime, saleWindowStart, saleWindowEnd,
  bufferHoursBefore = 2, bufferHoursAfter = 2 }) {
  // ----------------------------------------------------------
  // Step 1: Verify the venue exists.
  // ----------------------------------------------------------
  const venueCheck = await pool.query(
    'SELECT venue_id, venue_name FROM venues WHERE venue_id = $1',
    [venueId]
  );

  if (venueCheck.rows.length === 0) {
    throw new Error(`Venue with ID ${venueId} does not exist. Create the venue first.`);
  }

  const venueName = venueCheck.rows[0].venue_name;

  // ----------------------------------------------------------
  // Step 2: Check for venue time conflicts.
  //
  // We calculate the "blocked window" for the new event:
  //   blockedStart = startTime - bufferHoursBefore
  //   blockedEnd   = endTime   + bufferHoursAfter
  //
  // Then we check if ANY existing event at this venue has a
  // blocked window that overlaps with this one.
  //
  // Two time ranges [A_start, A_end] and [B_start, B_end]
  // overlap if and only if: A_start < B_end AND A_end > B_start
  // (this is the standard interval overlap formula).
  //
  // We exclude events with status 'closed' since those are
  // finished and their venue slot is free again.
  // ----------------------------------------------------------
  const conflictCheck = await pool.query(
    `SELECT e.event_id, e.event_name,
            e.event_start_time, e.event_end_time
     FROM events e
     WHERE e.venue_id = $1
       AND e.status != 'closed'
       AND (
         (e.event_start_time - (COALESCE(e.buffer_hours_before, 2) || ' hours')::interval) < ($3::timestamp + ($5 || ' hours')::interval)
         AND
         (e.event_end_time + (COALESCE(e.buffer_hours_after, 2) || ' hours')::interval) > ($2::timestamp - ($4 || ' hours')::interval)
       )`,
    [venueId, startTime, endTime, bufferHoursBefore.toString(), bufferHoursAfter.toString()]
  );

  if (conflictCheck.rows.length > 0) {
    const conflict = conflictCheck.rows[0];
    const conflictStart = new Date(conflict.event_start_time).toLocaleString('en-IN');
    const conflictEnd = new Date(conflict.event_end_time).toLocaleString('en-IN');
    throw new Error(
      `Venue "${venueName}" is already booked! ` +
      `"${conflict.event_name}" runs from ${conflictStart} to ${conflictEnd}. ` +
      `With buffer time, the venue is blocked. Choose a different time or venue.`
    );
  }

  // ----------------------------------------------------------
  // Step 3: Insert the event with status = 'draft'.
  // ----------------------------------------------------------
  const result = await pool.query(
    `INSERT INTO events
       (org_id, venue_id, event_name, description, category,
        event_start_time, event_end_time, sale_window_start, sale_window_end,
        buffer_hours_before, buffer_hours_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING event_id, org_id, venue_id, event_name, description, category,
               event_start_time, event_end_time, status,
               sale_window_start, sale_window_end,
               buffer_hours_before, buffer_hours_after, created_at`,
    [orgId, venueId, name, description || null, category || null,
      startTime, endTime, saleWindowStart || null, saleWindowEnd || null,
      bufferHoursBefore, bufferHoursAfter]
  );

  return result.rows[0];
}


// ============================================================
// getAllEvents(filters)
// ============================================================
// Returns a list of events, optionally filtered by:
//   - status: only show events in a specific status
//   - cityId: only show events at venues in a specific city
//   - category: only show events in a specific category
//   - orgId: only show events created by a specific organizer
//
// The query JOINs with venues AND cities to include venue name
// and city name in the response — this saves the frontend from
// making separate API calls just to display where each event is.
//
// `cityId` FILTERING (was previously free-text `city`):
//   Because venues now store city_id (a foreign key, see
//   migration 003) instead of a free-text city string, filtering
//   is now an exact integer match (`v.city_id = $1`) instead of
//   a fuzzy ILIKE '%text%' match. This is both faster (integer
//   equality uses the index cleanly; ILIKE with a leading
//   wildcard cannot) and more correct (no more "Bangalore" vs
//   "bangalore" vs "Bengaluru" mismatches).
//
//   `cityId` also accepts the literal string "all" (or is simply
//   omitted) to mean "don't filter by city at all" — this is
//   what powers the "All" option in the customer dashboard's
//   city filter dropdown, alongside each individual city.
//
// Results are ordered by event_start_time ascending (soonest
// events first) — this is the natural ordering customers
// expect when browsing upcoming events.
//
// NOTE: For customers, we typically filter to published/live
// events only. Organizers can see their own drafts too.
// ============================================================
async function getAllEvents(filters = {}) {
  // ----------------------------------------------------------
  // Build the WHERE clause dynamically based on which filters
  // were provided. We start with "1=1" (always true) so every
  // subsequent filter can use "AND" without worrying about
  // whether it's the first condition or not.
  // ----------------------------------------------------------
  const conditions = ['1=1'];
  const values = [];
  let paramIndex = 1;

  // Filter by event status (e.g., 'published', 'live')
  if (filters.status) {
    conditions.push(`e.status = $${paramIndex}`);
    values.push(filters.status);
    paramIndex++;
  }

  // Filter by venue city_id. "all" (or omitting the filter
  // entirely) means no city filtering — every city is included.
  if (filters.cityId && filters.cityId !== 'all') {
    conditions.push(`v.city_id = $${paramIndex}`);
    values.push(filters.cityId);
    paramIndex++;
  }

  // Filter by event category (e.g., 'Music')
  if (filters.category) {
    conditions.push(`e.category ILIKE $${paramIndex}`);
    values.push(`%${filters.category}%`);
    paramIndex++;
  }

  // Filter by organizer (for organizer dashboard — "show my events")
  if (filters.orgId) {
    conditions.push(`e.org_id = $${paramIndex}`);
    values.push(filters.orgId);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT e.event_id, e.event_name, e.description, e.category,
            e.event_start_time, e.event_end_time, e.status,
            e.sale_window_start, e.sale_window_end,
            e.created_at, e.updated_at,
            v.venue_id, v.venue_name,
            c.city_id, c.city_name
     FROM events e
     JOIN venues v ON e.venue_id = v.venue_id
     JOIN cities c ON c.city_id = v.city_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY e.event_start_time ASC`,
    values
  );

  return result.rows;
}


// ============================================================
// getEventById(eventId)
// ============================================================
// Returns a single event with full details, including:
//   - All event fields
//   - Venue info (name, address, city, capacity)
//   - Organizer name
//   - Current section pricing (from event_section_pricing,
//     only if the event has been published)
//
// This is used for the event detail page that customers see
// before deciding to buy tickets.
// ============================================================
async function getEventById(eventId) {
  // ----------------------------------------------------------
  // Main query: JOIN events with venues, cities, and organizers
  // to get everything in one round-trip.
  //
  // The extra JOIN to `cities` replaces the old `v.city` free-
  // text column (removed in migration 003) — venues now store
  // city_id, so we resolve the readable city name/state here.
  // ----------------------------------------------------------
  const result = await pool.query(
    `SELECT e.event_id, e.event_name, e.description, e.category,
            e.event_start_time, e.event_end_time, e.status,
            e.sale_window_start, e.sale_window_end,
            e.buffer_hours_before, e.buffer_hours_after,
            e.created_at, e.updated_at,
            v.venue_id, v.venue_name, v.address, v.total_capacity,
            v.seat_layout_json,
            c.city_id, c.city_name, c.state,
            o.org_id, o.org_name
     FROM events e
     JOIN venues v ON e.venue_id = v.venue_id
     JOIN cities c ON c.city_id = v.city_id
     JOIN organizers o ON e.org_id = o.org_id
     WHERE e.event_id = $1`,
    [eventId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Event with ID ${eventId} not found`);
  }

  const event = result.rows[0];

  // ----------------------------------------------------------
  // If the event is published (or beyond), also fetch the
  // current section pricing. This tells the frontend what
  // each section costs right now, which it can display on
  // the event detail page before the customer enters the
  // seat map.
  //
  // For draft events, this table has no rows — pricing doesn't
  // exist until publish time.
  // ----------------------------------------------------------
  let sectionPricing = [];

  if (event.status !== 'draft') {
    const pricingResult = await pool.query(
      `SELECT section, price
       FROM event_section_pricing
       WHERE event_id = $1
       ORDER BY price DESC`,
      [eventId]
    );
    sectionPricing = pricingResult.rows;
  }

  return {
    ...event,
    sectionPricing,
  };
}


// ============================================================
// updateEvent(eventId, orgId, updates)
// ============================================================
// Updates editable fields on an event. The organizer can change:
//   - event_name, description, category
//   - event_start_time, event_end_time
//   - sale_window_start, sale_window_end
//
// SECURITY: We verify that the event belongs to the requesting
// organizer (orgId from JWT). An organizer cannot edit another
// organizer's event.
//
// NOTE: venue_id is NOT editable after creation — changing the
// venue would invalidate all generated seats.
// ============================================================
async function updateEvent(eventId, orgId, updates) {
  // ----------------------------------------------------------
  // Step 1: Verify the event exists and belongs to this organizer
  // ----------------------------------------------------------
  const eventCheck = await pool.query(
    `SELECT e.event_id, e.org_id, e.venue_id, e.event_start_time, e.event_end_time,
            e.buffer_hours_before, e.buffer_hours_after, v.venue_name
     FROM events e
     JOIN venues v ON e.venue_id = v.venue_id
     WHERE e.event_id = $1`,
    [eventId]
  );

  if (eventCheck.rows.length === 0) {
    throw new Error(`Event with ID ${eventId} not found`);
  }

  const existingEvent = eventCheck.rows[0];

  if (existingEvent.org_id !== orgId) {
    throw new Error('You do not have permission to edit this event');
  }

  // ----------------------------------------------------------
  // Step 1b: If times are updated, check for venue conflicts.
  // ----------------------------------------------------------
  const newStartTime = updates.startTime !== undefined ? updates.startTime : existingEvent.event_start_time;
  const newEndTime = updates.endTime !== undefined ? updates.endTime : existingEvent.event_end_time;
  const newBufferBefore = updates.bufferHoursBefore !== undefined ? updates.bufferHoursBefore : existingEvent.buffer_hours_before;
  const newBufferAfter = updates.bufferHoursAfter !== undefined ? updates.bufferHoursAfter : existingEvent.buffer_hours_after;

  if (updates.startTime !== undefined || updates.endTime !== undefined ||
      updates.bufferHoursBefore !== undefined || updates.bufferHoursAfter !== undefined) {

    const conflictCheck = await pool.query(
      `SELECT e.event_id, e.event_name,
              e.event_start_time, e.event_end_time
       FROM events e
       WHERE e.venue_id = $1
         AND e.event_id != $2
         AND e.status != 'closed'
         AND (
           (e.event_start_time - (COALESCE(e.buffer_hours_before, 2) || ' hours')::interval) < ($4::timestamp + ($6 || ' hours')::interval)
           AND
           (e.event_end_time + (COALESCE(e.buffer_hours_after, 2) || ' hours')::interval) > ($3::timestamp - ($5 || ' hours')::interval)
         )`,
      [existingEvent.venue_id, eventId, newStartTime, newEndTime, newBufferBefore, newBufferAfter]
    );

    if (conflictCheck.rows.length > 0) {
      const conflict = conflictCheck.rows[0];
      const conflictStart = new Date(conflict.event_start_time).toLocaleString('en-IN');
      const conflictEnd = new Date(conflict.event_end_time).toLocaleString('en-IN');
      throw new Error(
        `Venue "${existingEvent.venue_name}" is already booked! ` +
        `"${conflict.event_name}" runs from ${conflictStart} to ${conflictEnd}. ` +
        `With buffer time, the venue is blocked. Choose a different time.`
      );
    }
  }

  // ----------------------------------------------------------
  // Step 2: Build the dynamic UPDATE query.
  // Only include fields that were actually provided — undefined
  // fields are NOT updated (preserving existing values).
  // ----------------------------------------------------------
  const allowedFields = {
    name: 'event_name',
    description: 'description',
    category: 'category',
    startTime: 'event_start_time',
    endTime: 'event_end_time',
    saleWindowStart: 'sale_window_start',
    saleWindowEnd: 'sale_window_end',
    bufferHoursBefore: 'buffer_hours_before',
    bufferHoursAfter: 'buffer_hours_after',
  };

  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  for (const [key, column] of Object.entries(allowedFields)) {
    if (updates[key] !== undefined) {
      setClauses.push(`${column} = $${paramIndex}`);
      // Allow explicitly setting to null (e.g., clearing sale window)
      values.push(updates[key] === '' ? null : updates[key]);
      paramIndex++;
    }
  }

  if (setClauses.length === 0) {
    throw new Error('No fields to update');
  }

  // Add updated_at timestamp
  setClauses.push(`updated_at = NOW()`);

  values.push(eventId);

  const result = await pool.query(
    `UPDATE events
     SET ${setClauses.join(', ')}
     WHERE event_id = $${paramIndex}
     RETURNING event_id, event_name, description, category,
               event_start_time, event_end_time, status,
               sale_window_start, sale_window_end,
               buffer_hours_before, buffer_hours_after, updated_at`,
    values
  );

  return result.rows[0];
}


module.exports = { createEvent, getAllEvents, getEventById, updateEvent };
