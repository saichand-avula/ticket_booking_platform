// ============================================================
// ticketRoutes.js — Ticket retrieval endpoints
//
// Endpoints:
//   GET /api/tickets/my         → Get all customer's tickets
//   GET /api/tickets/:ticketId  → Get single ticket with QR
// ============================================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/authMiddleware');
const { getMyTickets, getTicketById } = require('../service/ticketService');


// ============================================================
// GET /api/tickets/my
// ============================================================
router.get('/my', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ message: 'Only customers can view tickets' });
    }

    const tickets = await getMyTickets(req.user.id);
    res.json(tickets);
  } catch (err) {
    console.error('Error fetching tickets:', err);
    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// GET /api/tickets/:ticketId
// ============================================================
router.get('/:ticketId', authenticate, async (req, res) => {
  try {
    const ticket = await getTicketById(req.params.ticketId, req.user.id);
    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }
    res.json(ticket);
  } catch (err) {
    console.error('Error fetching ticket:', err);
    res.status(500).json({ message: err.message });
  }
});


module.exports = router;
