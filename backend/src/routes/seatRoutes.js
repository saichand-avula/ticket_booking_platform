// ============================================================
// seatRoutes.js — Seat map endpoint (Redis-only reads)
//
// The seat map is read entirely from Redis.
// PostgreSQL is consulted only for seat metadata (section,
// row, number, price) which is static and cacheable.
//
// Endpoints:
//   GET /api/events/:eventId/seats → full seat map + states
// ============================================================

const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticate } = require('../middleware/authMiddleware');
const { getSeatMap } = require('../service/redisInventoryService');
const pool = require('../config/db');


// ============================================================
// GET /api/events/:eventId/seats
// ============================================================
// Returns all seats for the event with their real-time state
// from Redis.
//
// The holdId query param (optional) allows the frontend to
// distinguish HELD_BY_CURRENT_USER vs HELD_BY_OTHER.
//
// Response: {
//   seats: [
//     {
//       seat_id, section, row_label, seat_number, price,
//       state: 'AVAILABLE' | 'HELD_BY_YOU' | 'HELD_BY_OTHER' | 'BOOKED'
//     }
//   ]
// }
// ============================================================
router.get('/', authenticate, async (req, res) => {
  try {
    const { eventId } = req.params;
    const holdId = req.query.holdId || null;

    // Step 1: Get seat metadata from PostgreSQL (static data)
    const seatResult = await pool.query(
      `SELECT seat_id, section, row_label, seat_number, price
       FROM seats
       WHERE event_id = $1
       ORDER BY section, row_label, seat_number`,
      [eventId]
    );

    if (seatResult.rows.length === 0) {
      return res.json({ seats: [] });
    }

    // Step 2: Get real-time states from Redis (MGET)
    const seatIds = seatResult.rows.map(s => s.seat_id);
    const redisStates = await getSeatMap(eventId, seatIds);

    // Step 3: Merge metadata + state
    const currentHoldValue = holdId ? `HELD:${holdId}` : null;

    const seats = seatResult.rows.map(seat => {
      const redisState = redisStates[seat.seat_id] || 'AVAILABLE';
      let displayState;

      if (redisState === 'AVAILABLE') {
        displayState = 'AVAILABLE';
      } else if (redisState === 'BOOKED') {
        displayState = 'BOOKED';
      } else if (redisState.startsWith('HELD:')) {
        displayState = (currentHoldValue && redisState === currentHoldValue)
          ? 'HELD_BY_YOU'
          : 'HELD_BY_OTHER';
      } else if (redisState.startsWith('FINALIZING:')) {
        displayState = (holdId && redisState === `FINALIZING:${holdId}`)
          ? 'HELD_BY_YOU'
          : 'HELD_BY_OTHER';
      } else {
        displayState = 'AVAILABLE'; // fallback
      }

      return {
        seat_id: seat.seat_id,
        section: seat.section,
        row_label: seat.row_label,
        seat_number: seat.seat_number,
        price: parseFloat(seat.price),
        state: displayState,
      };
    });

    res.json({ seats });
  } catch (err) {
    console.error('Error fetching seat map:', err);
    res.status(500).json({ message: err.message });
  }
});


module.exports = router;
