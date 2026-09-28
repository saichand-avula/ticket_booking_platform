// ============================================================
// bookingSessionRoutes.js — Session-based seat selection API
//
// These endpoints handle the seat selection phase:
//
//   POST   /api/events/:eventId/booking-sessions         → create session
//   POST   /api/booking-sessions/:sessionId/seats/:seatId → select seat
//   DELETE /api/booking-sessions/:sessionId/seats/:seatId → deselect seat
//   POST   /api/booking-sessions/:sessionId/proceed       → proceed to payment
//   GET    /api/booking-sessions/:sessionId               → get session status
//
// Each seat selection goes through Redis atomic acquisition.
// The frontend displays optimistic UI but the backend validates.
// ============================================================

const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticate } = require('../middleware/authMiddleware');

const {
  createSession,
  getSession,
  validateSession,
  addSeatToSession,
  removeSeatFromSession,
} = require('../service/bookingSessionService');

const {
  acquireSeats,
  releaseSeat,
  releaseSeats,
  finalizeSeats,
  getSeatMap,
  PAYMENT_TTL,
} = require('../service/redisInventoryService');

const redis = require('../config/redis');
const pool = require('../config/db');
const { broadcastSeatUpdate } = require('../ws/seatBroadcast');


// ============================================================
// POST /api/events/:eventId/booking-sessions
// ============================================================
// Creates a new booking session when the customer enters the
// seat selection page. Returns sessionId, holdId, and TTL.
// ============================================================
router.post('/events/:eventId/booking-sessions', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ message: 'Only customers can create booking sessions' });
    }

    const { eventId } = req.params;

    // Verify event exists and is published/live
    const eventResult = await pool.query(
      `SELECT status, sale_window_start, sale_window_end FROM events WHERE event_id = $1`,
      [eventId]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ message: 'Event not found' });
    }

    const event = eventResult.rows[0];
    const now = new Date();

    if (event.status !== 'published' && event.status !== 'live') {
      return res.status(400).json({ message: 'Event is not open for booking' });
    }

    if (event.sale_window_start && now < new Date(event.sale_window_start)) {
      return res.status(400).json({ message: 'Sales have not started yet' });
    }

    if (event.sale_window_end && now > new Date(event.sale_window_end)) {
      return res.status(400).json({ message: 'Sales window has closed' });
    }

    const session = await createSession(req.user.id, eventId);
    res.status(201).json(session);
  } catch (err) {
    console.error('Error creating booking session:', err);
    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// POST /api/booking-sessions/:sessionId/seats/:seatId
// ============================================================
// Select (acquire) a seat. Backend validates in Redis atomically.
//
// On success: seat → HELD:{holdId} with 10 min TTL
// On failure: seat is unavailable (held/booked by someone else)
// ============================================================
router.post('/booking-sessions/:sessionId/seats/:seatId', authenticate, async (req, res) => {
  try {
    const { sessionId, seatId } = req.params;

    // Validate session
    const { valid, session, message } = await validateSession(sessionId, req.user.id);
    if (!valid) {
      return res.status(400).json({ message });
    }

    // Max 10 seats per session
    if (session.selectedSeats.length >= 10) {
      return res.status(400).json({ message: 'Maximum 10 seats per booking' });
    }

    // Already selected?
    if (session.selectedSeats.includes(parseInt(seatId))) {
      return res.status(400).json({ message: 'Seat already selected' });
    }

    // Get remaining session TTL so the seat key expires at the same time
    const sessionTtl = await redis.ttl(`session:${sessionId}`);
    if (sessionTtl <= 0) {
      return res.status(400).json({ message: 'Session expired' });
    }

    // Atomic acquisition in Redis — use session TTL so seat expires with session
    const result = await acquireSeats(session.eventId, [parseInt(seatId)], session.holdId, sessionTtl);

    if (!result.success) {
      return res.status(409).json({ message: result.message });
    }

    // Track in session
    await addSeatToSession(sessionId, parseInt(seatId));

    res.json({
      success: true,
      seatId: parseInt(seatId),
      holdId: session.holdId,
    });

    // Broadcast real-time update (fire-and-forget)
    broadcastSeatUpdate(session.eventId, 'SEAT_HELD', parseInt(seatId));
  } catch (err) {
    console.error('Error selecting seat:', err);
    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// DELETE /api/booking-sessions/:sessionId/seats/:seatId
// ============================================================
// Deselect (release) a seat. Only releases if owned by this hold.
// ============================================================
router.delete('/booking-sessions/:sessionId/seats/:seatId', authenticate, async (req, res) => {
  try {
    const { sessionId, seatId } = req.params;

    const { valid, session, message } = await validateSession(sessionId, req.user.id);
    if (!valid) {
      return res.status(400).json({ message });
    }

    // Release from Redis
    const released = await releaseSeat(session.eventId, parseInt(seatId), session.holdId);

    if (released) {
      await removeSeatFromSession(sessionId, parseInt(seatId));
      // Broadcast real-time update
      broadcastSeatUpdate(session.eventId, 'SEAT_AVAILABLE', parseInt(seatId));
    }

    res.json({ success: true, released });
  } catch (err) {
    console.error('Error deselecting seat:', err);
    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// POST /api/booking-sessions/:sessionId/proceed
// ============================================================
// User clicks "Proceed to Payment". Validates:
//   1. Session is still valid
//   2. All selected seats still belong to this hold in Redis
//   3. Creates a payment timer (5 min) in Redis
//
// Returns seat details + prices for the checkout page.
// ============================================================
router.post('/booking-sessions/:sessionId/proceed', authenticate, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const { valid, session, message } = await validateSession(sessionId, req.user.id);
    if (!valid) {
      return res.status(400).json({ message });
    }

    if (session.selectedSeats.length === 0) {
      return res.status(400).json({ message: 'No seats selected' });
    }

    // Verify all seats still belong to this hold in Redis
    const seatMap = await getSeatMap(session.eventId, session.selectedSeats);
    const expectedHold = `HELD:${session.holdId}`;

    for (const seatId of session.selectedSeats) {
      if (seatMap[seatId] !== expectedHold) {
        return res.status(409).json({
          message: `Seat ${seatId} is no longer held by your session. It may have expired.`,
        });
      }
    }

    // Get seat details + prices from PostgreSQL (one-time read)
    const seatDetails = await pool.query(
      `SELECT s.seat_id, s.section, s.row_label, s.seat_number, s.price
       FROM seats s
       WHERE s.seat_id = ANY($1) AND s.event_id = $2`,
      [session.selectedSeats, session.eventId]
    );

    // Get event name + venue for checkout display
    const eventDetails = await pool.query(
      `SELECT e.event_name, v.venue_name
       FROM events e JOIN venues v ON e.venue_id = v.venue_id
       WHERE e.event_id = $1`,
      [session.eventId]
    );

    const totalAmount = seatDetails.rows.reduce((sum, s) => sum + parseFloat(s.price), 0);

    // Create payment timer (5 min)
    await redis.set(
      `payment_timer:${sessionId}`,
      JSON.stringify({
        sessionId,
        holdId: session.holdId,
        userId: session.userId,
        eventId: session.eventId,
        seatIds: session.selectedSeats,
        createdAt: Date.now(),
      }),
      'EX',
      PAYMENT_TTL
    );

    res.json({
      sessionId,
      holdId: session.holdId,
      eventId: session.eventId,
      eventName: eventDetails.rows[0]?.event_name,
      venueName: eventDetails.rows[0]?.venue_name,
      seats: seatDetails.rows.map(s => ({
        seat_id: s.seat_id,
        section: s.section,
        row: s.row_label,
        seatNumber: s.seat_number,
        price: parseFloat(s.price),
      })),
      totalAmount,
      paymentTtl: PAYMENT_TTL,
      paymentExpiresAt: Date.now() + (PAYMENT_TTL * 1000),
    });
  } catch (err) {
    console.error('Error proceeding to payment:', err);
    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// GET /api/booking-sessions/:sessionId
// ============================================================
// Returns current session status (used by frontend for polling).
// ============================================================
router.get('/booking-sessions/:sessionId', authenticate, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const { valid, session, message } = await validateSession(sessionId, req.user.id);
    if (!valid) {
      return res.status(400).json({ message, expired: true });
    }

    const ttl = await redis.ttl(`session:${sessionId}`);

    res.json({
      ...session,
      ttlRemaining: ttl,
    });
  } catch (err) {
    console.error('Error getting session:', err);
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// DELETE /api/booking-sessions/:sessionId
// ============================================================
// Explicitly cancels a session, releasing all its held seats.
// Used when:
//   - The 10-minute selection timer expires on frontend
//   - The user clicks "Back to Event"
//
// IMPORTANT: By the time the frontend timer hits 0, the Redis
// session key has ALSO expired (same 600s TTL). So validateSession
// will return false. That's why we accept holdId, eventId, and
// seatIds in the body as a fallback — the frontend always has
// this data from when the session was created.
// ============================================================
router.delete('/booking-sessions/:sessionId', authenticate, async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Try to get session from Redis first
    const { valid, session } = await validateSession(sessionId, req.user.id);

    // Use session data if available, otherwise fall back to body params
    const holdId = session?.holdId || req.body?.holdId;
    const eventId = session?.eventId || req.body?.eventId;
    const seatIds = (session?.selectedSeats?.length > 0)
      ? session.selectedSeats
      : (req.body?.seatIds || []);

    if (!holdId || !eventId) {
      // No session and no fallback data — nothing we can do
      return res.status(200).json({ success: true, message: 'Already cleaned up' });
    }

    // Release seats from Redis
    if (seatIds.length > 0) {
      await releaseSeats(eventId, seatIds, holdId);

      // Broadcast release via WebSocket
      try {
        const { broadcastMultiSeatUpdate } = require('../ws/seatBroadcast');
        broadcastMultiSeatUpdate(eventId, 'SEAT_AVAILABLE', seatIds);
      } catch {}
    }

    // Delete session key (if it still exists)
    await redis.del(`session:${sessionId}`);

    // Release waiting room slot
    try {
      const { releaseSlot } = require('../service/waitingRoomService');
      await releaseSlot(eventId, req.user.id);
    } catch {}

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting session:', err);
    res.status(500).json({ message: err.message });
  }
});


module.exports = router;
