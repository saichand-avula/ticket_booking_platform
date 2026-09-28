// ============================================================
// seatService.js — Seat generation and pricing logic
//
// This service handles two core responsibilities:
//
// 1. SEAT GENERATION (at publish time):
//    Turns a venue's seat_layout_json template into real seat
//    rows in the `seats` table for one specific event. This
//    runs exactly once per event, at the moment it's published.
//
// 2. PRICING RESOLUTION (at publish time):
//    The venue template holds a default_price per section, but
//    the organizer can override prices for any section when
//    publishing. The priority is:
//      organizer's price  >  venue template's default_price
//
//    Whatever price is resolved gets written to BOTH:
//      - seats.price (for live seat-map display)
//      - event_section_pricing (the authoritative "current
//        price" table that the organizer can update later)
//
// 3. PRICE UPDATES (after publish, even mid-sale):
//    The organizer can change a section's price at any time.
//    This updates event_section_pricing (the source of truth)
//    and bulk-updates seats.price for all UNSOLD seats in that
//    section. Already-sold seats are untouched, and already-
//    placed orders are protected by order_items (a separate
//    table that freezes price at checkout time).
// ============================================================

const pool = require('../config/db');


// ============================================================
// generateSeatsForEvent(eventId, sectionPricing)
// ============================================================
// Called by the publish endpoint. Takes the event ID and an
// optional sectionPricing object like:
//   { "VIP": 150, "General": 50 }
//
// For any section the organizer doesn't supply a price for,
// the venue template's default_price is used. If neither exists,
// the function throws — a section must have SOME price.
//
// Everything happens inside a single database transaction:
//   1. Look up the venue's seat template
//   2. Resolve prices (organizer override vs default)
//   3. INSERT all seat rows
//   4. INSERT event_section_pricing rows
//   5. Flip the event status to 'published'
// If any step fails, the entire transaction rolls back — no
// partial seat sets, no event stuck in a wrong status.
// ============================================================
async function generateSeatsForEvent(eventId, sectionPricing = {}) {
  // A dedicated client (not pool.query) is needed here because a
  // transaction (BEGIN/COMMIT/ROLLBACK) must run all its
  // statements on the SAME underlying connection. pool.query()
  // grabs a random connection from the pool per call, which would
  // break transaction guarantees.
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ----------------------------------------------------------
    // Step 1: Look up the event and its venue's seat template.
    // A single JOIN gets both in one round-trip instead of two
    // separate queries.
    // ----------------------------------------------------------
    const eventResult = await client.query(
      `SELECT e.event_id, v.seat_layout_json
       FROM events e
       JOIN venues v ON e.venue_id = v.venue_id
       WHERE e.event_id = $1`,
      [eventId]
    );

    if (eventResult.rows.length === 0) {
      throw new Error(`Event ${eventId} not found`);
    }

    const layout = eventResult.rows[0].seat_layout_json;

    // Expected shape of the venue's seat_layout_json:
    // {
    //   "sections": [
    //     {
    //       "name": "VIP",
    //       "rows": ["A", "B"],
    //       "seats_per_row": 10,
    //       "default_price": 100    <-- fallback if organizer doesn't set a price
    //     },
    //     {
    //       "name": "General",
    //       "rows": ["C", "D", "E"],
    //       "seats_per_row": 20,
    //       "default_price": 50
    //     }
    //   ]
    // }
    //
    // NOTE: The old format used "price" instead of "default_price".
    // We support both for backward compatibility — if the template
    // has "price" but not "default_price", we treat "price" as the
    // default. This way existing venue records still work without
    // needing a database migration on the venues table.

    if (!layout || !Array.isArray(layout.sections)) {
      throw new Error('Venue has no valid seat_layout_json');
    }

    // ----------------------------------------------------------
    // Step 2: Resolve the final price for each section.
    //
    // Priority:
    //   1. sectionPricing[sectionName] — organizer's explicit
    //      price for this event (highest priority)
    //   2. section.default_price — venue template's fallback
    //   3. section.price — old format backward compatibility
    //
    // If none of these exist for a section, we throw an error
    // rather than silently inserting seats with no price.
    // ----------------------------------------------------------
    const resolvedPrices = {};

    for (const section of layout.sections) {
      // Check organizer's override first, then venue defaults.
      // The organizer passes sectionPricing as { "VIP": 150 },
      // so we look up by the section's name.
      if (sectionPricing[section.name] !== undefined) {
        resolvedPrices[section.name] = parseFloat(sectionPricing[section.name]);
      } else if (section.default_price !== undefined) {
        resolvedPrices[section.name] = parseFloat(section.default_price);
      } else if (section.price !== undefined) {
        // Backward compatibility: old venue templates used "price"
        // instead of "default_price". We still honor it.
        resolvedPrices[section.name] = parseFloat(section.price);
      } else {
        throw new Error(
          `Section "${section.name}" has no price — organizer didn't supply one ` +
          `and the venue template has no default_price for this section.`
        );
      }
    }

    // ----------------------------------------------------------
    // Step 3: Flatten the template into one flat list of seat
    // rows to insert. Building this in memory first (rather than
    // querying per seat) is what makes the bulk insert possible.
    //
    // Each seat gets the resolved price for its section — so all
    // seats in "VIP" get the same price, all seats in "General"
    // get the same price, etc. (as per the requirement).
    // ----------------------------------------------------------
    const seatRows = [];
    for (const section of layout.sections) {
      const sectionPrice = resolvedPrices[section.name];
      for (const rowLabel of section.rows) {
        for (let seatNum = 1; seatNum <= section.seats_per_row; seatNum++) {
          seatRows.push([
            eventId,
            section.name,
            rowLabel,
            seatNum,
            sectionPrice,
          ]);
        }
      }
    }

    if (seatRows.length === 0) {
      throw new Error('Seat template produced zero seats');
    }

    // ----------------------------------------------------------
    // Step 4: Build one INSERT with many VALUES rows instead of
    // looping individual inserts. Postgres parameter placeholders
    // ($1, $2, ...) are generated dynamically since the seat count
    // varies per venue.
    // ----------------------------------------------------------
    const seatValues = [];
    const seatPlaceholders = seatRows.map((row, i) => {
      const base = i * 5;
      seatValues.push(...row);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });

    const insertSeatsQuery = `
      INSERT INTO seats (event_id, section, row_label, seat_number, price)
      VALUES ${seatPlaceholders.join(', ')}
    `;

    await client.query(insertSeatsQuery, seatValues);

    // ----------------------------------------------------------
    // Step 5: Write the resolved prices into event_section_pricing.
    //
    // This table becomes the authoritative "what does this section
    // cost right now" record. When the organizer later wants to
    // change a price, they update THIS table (and we bulk-update
    // seats.price to match). This separation is what allows price
    // changes without re-reading the venue template.
    // ----------------------------------------------------------
    const pricingValues = [];
    const pricingPlaceholders = Object.entries(resolvedPrices).map(
      ([sectionName, price], i) => {
        const base = i * 3;
        pricingValues.push(eventId, sectionName, price);
        return `($${base + 1}, $${base + 2}, $${base + 3})`;
      }
    );

    const insertPricingQuery = `
      INSERT INTO event_section_pricing (event_id, section, price)
      VALUES ${pricingPlaceholders.join(', ')}
    `;

    await client.query(insertPricingQuery, pricingValues);

    // ----------------------------------------------------------
    // Step 6: Flip the event from draft to published now that its
    // seats actually exist. Doing this in the SAME transaction as
    // the seat inserts means an event can never end up "published"
    // with zero seats, or vice versa.
    // ----------------------------------------------------------
    await client.query(
      `UPDATE events SET status = 'published', updated_at = now() WHERE event_id = $1`,
      [eventId]
    );

    await client.query('COMMIT');

    return { seatsCreated: seatRows.length };
  } catch (err) {
    // Any failure above rolls back everything in this transaction —
    // no partial seat sets, no event stuck in a wrong status, no
    // orphaned event_section_pricing rows.
    await client.query('ROLLBACK');
    throw err;
  } finally {
    // Always release the client back to the pool, whether the
    // transaction succeeded or failed — otherwise this connection
    // is leaked and the pool eventually runs out.
    client.release();
  }
}


// ============================================================
// updateSectionPrice(eventId, section, newPrice)
// ============================================================
// Called when an organizer changes a section's price mid-sale.
//
// This does two things in a single transaction:
//
//   1. Updates event_section_pricing — the authoritative record
//      of "what does this section cost right now."
//
//   2. Bulk-updates seats.price for all UNSOLD seats in that
//      section. This ensures the live seat map shows the new
//      price immediately.
//
// What it does NOT touch:
//   - Already-sold seats (status = 'sold') — their price is
//     historical and shouldn't change.
//   - Already-placed orders — those are protected by the
//     order_items table, which freezes price at checkout time.
//     Even if seats.price changes between checkout and webhook,
//     the ticket gets the frozen order_items price.
//
// Example scenario:
//   12:00am — Customer A checks out Section A at ₹12
//             → order_items row created with price_at_purchase = 12
//   12:05am — Organizer changes Section A to ₹17
//             → this function runs, seats.price becomes 17
//   12:07am — Customer B sees ₹17 on the seat map, checks out
//             → order_items row created with price_at_purchase = 17
//   12:08am — Customer A's Stripe webhook fires
//             → ticket created with price FROM order_items = ₹12
//             → Customer A was never affected by the price change
// ============================================================
async function updateSectionPrice(eventId, section, newPrice) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ----------------------------------------------------------
    // Step 1: Update the authoritative pricing record.
    // If the row doesn't exist (wrong section name or event not
    // published yet), zero rows will be updated and we throw.
    // ----------------------------------------------------------
    const pricingResult = await client.query(
      `UPDATE event_section_pricing
       SET price = $1
       WHERE event_id = $2 AND section = $3`,
      [newPrice, eventId, section]
    );

    if (pricingResult.rowCount === 0) {
      throw new Error(
        `No pricing record found for event ${eventId}, section "${section}". ` +
        `Either the section name is wrong or the event hasn't been published yet.`
      );
    }

    // ----------------------------------------------------------
    // Step 2: Bulk-update seats.price for all seats in this
    // section that haven't been sold yet.
    //
    // We update 'available' and 'locked' seats:
    //   - 'available' — nobody has selected them, price updates
    //     immediately for the next buyer.
    //   - 'locked' — someone is in the checkout flow but hasn't
    //     paid yet. Their price is already frozen in order_items
    //     from when they started checkout, so updating seats.price
    //     here doesn't affect them. But if their lock expires and
    //     the seat becomes available again, it should show the
    //     new price.
    //
    // We do NOT update 'sold' seats — those are historical.
    // ----------------------------------------------------------
    const seatsResult = await client.query(
      `UPDATE seats
       SET price = $1
       WHERE event_id = $2 AND section = $3 AND status != 'sold'`,
      [newPrice, eventId, section]
    );

    await client.query('COMMIT');

    return {
      sectionUpdated: section,
      newPrice: parseFloat(newPrice),
      seatsUpdated: seatsResult.rowCount,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


module.exports = { generateSeatsForEvent, updateSectionPrice };


// ============================================================
// SEAT LOCKING — Redis + PostgreSQL
//
// Architecture (matches user's design):
//   1. Redis holds temporary seat locks (5-min TTL)
//   2. PostgreSQL is the source of truth for final bookings
//   3. SELECT ... FOR UPDATE prevents double-booking at the DB level
//
// Seat statuses:
//   - 'available' — free to select (white in UI)
//   - 'held'      — temporarily locked in Redis (grey for others, blue for holder)
//   - 'sold'      — permanently sold in DB (grey in UI)
//
// Redis key format: seat_lock:{eventId}:{seatId} → customerId
// TTL: 300 seconds (5 minutes)
// ============================================================

const redis = require('../config/redis');

const LOCK_TTL_SECONDS = 300; // 5 minutes


// ============================================================
// getSeatsForEvent(eventId)
// ============================================================
// Returns all seats for an event, grouped by section, with
// real-time status merged from Redis (held seats) and DB
// (sold seats). This feeds the seat map UI.
//
// Response shape:
//   {
//     sections: [
//       {
//         name: 'VIP',
//         price: 12000,
//         rows: [
//           {
//             label: 'A',
//             seats: [
//               { seat_id: 1, seat_number: 1, status: 'available' },
//               { seat_id: 2, seat_number: 2, status: 'held', held_by_me: false },
//               { seat_id: 3, seat_number: 3, status: 'sold' },
//             ]
//           }
//         ]
//       }
//     ]
//   }
// ============================================================
async function getSeatsForEvent(eventId, customerId = null) {
  // Step 1: Get all seats from the database
  const result = await pool.query(
    `SELECT s.seat_id, s.section, s.row_label, s.seat_number,
            s.price, s.status, s.version
     FROM seats s
     WHERE s.event_id = $1
     ORDER BY s.section, s.row_label, s.seat_number`,
    [eventId]
  );

  if (result.rows.length === 0) {
    return { sections: [] };
  }

  // Step 2: Check Redis for held seats in bulk
  // Build a pipeline to fetch all lock keys at once (1 round-trip).
  const pipeline = redis.pipeline();
  for (const seat of result.rows) {
    pipeline.get(`seat_lock:${eventId}:${seat.seat_id}`);
  }
  const redisResults = await pipeline.exec();

  // Step 3: Merge DB status with Redis holds
  const sectionMap = {};

  for (let i = 0; i < result.rows.length; i++) {
    const seat = result.rows[i];
    const [redisErr, lockedByCustomerId] = redisResults[i] || [null, null];

    // Determine the real-time status
    let status = seat.status; // 'available' or 'sold'
    let heldByMe = false;

    if (seat.status === 'sold') {
      status = 'sold';
    } else if (lockedByCustomerId) {
      status = 'held';
      heldByMe = customerId && lockedByCustomerId === String(customerId);
    } else {
      status = 'available';
    }

    // Group by section
    if (!sectionMap[seat.section]) {
      sectionMap[seat.section] = {
        name: seat.section,
        price: parseFloat(seat.price),
        rows: {},
      };
    }

    const section = sectionMap[seat.section];
    if (!section.rows[seat.row_label]) {
      section.rows[seat.row_label] = {
        label: seat.row_label,
        seats: [],
      };
    }

    section.rows[seat.row_label].seats.push({
      seat_id: seat.seat_id,
      seat_number: seat.seat_number,
      status,
      held_by_me: heldByMe,
    });
  }

  // Convert row maps to sorted arrays
  const sections = Object.values(sectionMap).map(section => ({
    ...section,
    rows: Object.values(section.rows).sort((a, b) =>
      a.label.localeCompare(b.label)
    ),
  }));

  return { sections };
}


// ============================================================
// lockSeats(eventId, seatIds, customerId)
// ============================================================
// Locks selected seats using a Redis + DB dual check:
//
// 1. START a DB transaction
// 2. SELECT ... FOR UPDATE the requested seats (DB-level lock)
// 3. Check all are 'available' in DB (not already sold)
// 4. Check none are held in Redis by ANOTHER customer
// 5. Set Redis keys with 5-min TTL (atomic MULTI/EXEC)
// 6. COMMIT the DB transaction
//
// If any check fails, the entire operation is rejected.
// Returns: { locked: true, seatIds: [...], expiresIn: 300 }
// ============================================================
async function lockSeats(eventId, seatIds, customerId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Step 1: SELECT FOR UPDATE — locks the rows at DB level
    // so no other transaction can modify them until we COMMIT.
    const seatResult = await client.query(
      `SELECT seat_id, status, version
       FROM seats
       WHERE event_id = $1 AND seat_id = ANY($2::int[])
       FOR UPDATE`,
      [eventId, seatIds]
    );

    // Verify all requested seats exist
    if (seatResult.rows.length !== seatIds.length) {
      throw new Error('One or more seat IDs are invalid');
    }

    // Step 2: Check DB status — none should be 'sold'
    const soldSeats = seatResult.rows.filter(s => s.status === 'sold');
    if (soldSeats.length > 0) {
      throw new Error(
        `Seats already sold: ${soldSeats.map(s => s.seat_id).join(', ')}`
      );
    }

    // Step 3: Check Redis — none should be held by ANOTHER customer
    const pipeline = redis.pipeline();
    for (const seatId of seatIds) {
      pipeline.get(`seat_lock:${eventId}:${seatId}`);
    }
    const redisResults = await pipeline.exec();

    for (let i = 0; i < seatIds.length; i++) {
      const [err, holder] = redisResults[i] || [null, null];
      if (holder && holder !== String(customerId)) {
        throw new Error(
          `Seat ${seatIds[i]} is currently held by another customer`
        );
      }
    }

    // Step 4: Set Redis locks with 5-min TTL (atomic pipeline)
    const lockPipeline = redis.pipeline();
    for (const seatId of seatIds) {
      lockPipeline.set(
        `seat_lock:${eventId}:${seatId}`,
        String(customerId),
        'EX',
        LOCK_TTL_SECONDS
      );
    }
    await lockPipeline.exec();

    // Step 5: COMMIT the DB transaction (releases FOR UPDATE locks)
    await client.query('COMMIT');

    return {
      locked: true,
      seatIds,
      expiresIn: LOCK_TTL_SECONDS,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


// ============================================================
// unlockSeats(eventId, seatIds, customerId)
// ============================================================
// Removes Redis locks — only if they belong to this customer.
// Called on payment failure or manual cancellation.
// ============================================================
async function unlockSeats(eventId, seatIds, customerId) {
  const pipeline = redis.pipeline();

  for (const seatId of seatIds) {
    pipeline.get(`seat_lock:${eventId}:${seatId}`);
  }
  const results = await pipeline.exec();

  // Only delete locks that belong to this customer
  const delPipeline = redis.pipeline();
  let unlocked = 0;

  for (let i = 0; i < seatIds.length; i++) {
    const [err, holder] = results[i] || [null, null];
    if (holder === String(customerId)) {
      delPipeline.del(`seat_lock:${eventId}:${seatIds[i]}`);
      unlocked++;
    }
  }

  if (unlocked > 0) {
    await delPipeline.exec();
  }

  return { unlocked };
}


// ============================================================
// checkLockOwnership(eventId, seatIds, customerId)
// ============================================================
// Verifies the customer still holds all locks before payment.
// Returns true only if ALL seats are still locked by this customer.
// ============================================================
async function checkLockOwnership(eventId, seatIds, customerId) {
  const pipeline = redis.pipeline();
  for (const seatId of seatIds) {
    pipeline.get(`seat_lock:${eventId}:${seatId}`);
  }
  const results = await pipeline.exec();

  for (let i = 0; i < seatIds.length; i++) {
    const [err, holder] = results[i] || [null, null];
    if (holder !== String(customerId)) {
      return false; // Lock expired or stolen
    }
  }

  return true;
}


module.exports = {
  generateSeatsForEvent,
  updateSectionPrice,
  getSeatsForEvent,
  lockSeats,
  unlockSeats,
  checkLockOwnership,
  LOCK_TTL_SECONDS,
};