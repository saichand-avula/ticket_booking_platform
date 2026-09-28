// ============================================================
// waitingRoomRoutes.js — Waiting room queue endpoints
//
// Nested under /api/events/:eventId/waiting-room in server.js
//
// Endpoints:
//   POST /join       → Try to join / get admitted
//   GET  /position   → Poll current position
//   POST /release    → Release slot (called after payment)
// ============================================================

const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticate } = require('../middleware/authMiddleware');
const { tryAdmit, getPosition, releaseSlot } = require('../service/waitingRoomService');


// ============================================================
// POST /api/events/:eventId/waiting-room/join
// ============================================================
router.post('/join', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ message: 'Only customers can join the waiting room' });
    }

    const { eventId } = req.params;
    const result = await tryAdmit(eventId, req.user.id);
    res.json(result);
  } catch (err) {
    console.error('Error joining waiting room:', err);
    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// GET /api/events/:eventId/waiting-room/position
// ============================================================
router.get('/position', authenticate, async (req, res) => {
  try {
    const { eventId } = req.params;
    const result = await getPosition(eventId, req.user.id);
    res.json(result);
  } catch (err) {
    console.error('Error getting position:', err);
    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// POST /api/events/:eventId/waiting-room/release
// ============================================================
router.post('/release', authenticate, async (req, res) => {
  try {
    const { eventId } = req.params;
    const result = await releaseSlot(eventId, req.user.id);
    res.json(result);
  } catch (err) {
    console.error('Error releasing slot:', err);
    res.status(500).json({ message: err.message });
  }
});


module.exports = router;
