// ============================================================
// orderRoutes.js — Order payment endpoints
//
// Payment flow (simplified — no payment gateway):
//   1. POST /api/orders              → create PENDING_PAYMENT order
//   2. POST /api/orders/:orderId/pay → user confirms payment → finalize
//
// The PG transaction is NEVER open during payment.
// User clicks "Payment Done", then we finalize atomically.
// ============================================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/authMiddleware');
const { createOrder, confirmOrder, failOrder, getOrderById, getConfirmedOrderDetails } = require('../service/orderService');
const { createMockPaymentOrder } = require('../service/paymentService');
const { releaseSlot } = require('../service/waitingRoomService');


// ============================================================
// POST /api/orders
// ============================================================
// Creates a PENDING_PAYMENT order.
//
// Body: { sessionId, holdId, eventId, seatIds }
// ============================================================
router.post('/', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ message: 'Only customers can create orders' });
    }

    const { sessionId, holdId, eventId, seatIds } = req.body;

    if (!sessionId || !holdId || !eventId || !seatIds || !Array.isArray(seatIds)) {
      return res.status(400).json({
        message: 'sessionId, holdId, eventId, and seatIds array are required',
      });
    }

    // Step 1: Create app order (frozen prices)
    const order = await createOrder(
      req.user.id,
      parseInt(eventId),
      seatIds,
      holdId,
      sessionId
    );

    // Step 2: Create mock payment order reference
    const paymentOrder = await createMockPaymentOrder(order.orderId, order.totalAmount);

    res.status(201).json({
      orderId: order.orderId,
      totalAmount: order.totalAmount,
      paymentOrderId: paymentOrder.paymentOrderId,
      currency: paymentOrder.currency,
      mock: true,
    });
  } catch (err) {
    console.error('Error creating order:', err);
    res.status(400).json({ message: err.message });
  }
});


// ============================================================
// POST /api/orders/:orderId/pay
// ============================================================
// User confirms payment → finalize order.
//
//   1. confirmOrder() handles:
//      → Lua: HELD → FINALIZING
//      → Short PG TX: seats → BOOKED, tickets created
//      → Redis: FINALIZING → BOOKED
//
// Idempotent: duplicate callbacks return existing booking.
// ============================================================
router.post('/:orderId/pay', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ message: 'Only customers can pay for orders' });
    }

    const { orderId } = req.params;
    const paymentId = `pay_${Date.now()}`;

    // Confirm order (Lua → PG TX → Redis BOOKED)
    const confirmedOrder = await confirmOrder(parseInt(orderId), req.user.id);

    // Release waiting room slot
    try { await releaseSlot(confirmedOrder.eventId, req.user.id); } catch {}

    // Record payment in PostgreSQL
    const pool = require('../config/db');
    await pool.query(
      `INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
       VALUES ($1, 'manual', $2, $3, 'succeeded')
       ON CONFLICT DO NOTHING`,
      [parseInt(orderId), paymentId, confirmedOrder.totalAmount]
    );

    res.json(confirmedOrder);
  } catch (err) {
    console.error('Error processing payment:', err);

    // If finalization fails, try to fail the order cleanly
    try {
      await failOrder(parseInt(req.params.orderId), req.user.id);
      const order = await getOrderById(parseInt(req.params.orderId), req.user.id);
      if (order) await releaseSlot(order.event_id || order.eventId, req.user.id);
    } catch {}

    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// GET /api/orders/:orderId
// ============================================================
router.get('/:orderId', authenticate, async (req, res) => {
  try {
    // First check basic order info
    const order = await getOrderById(parseInt(req.params.orderId), req.user.id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // For confirmed orders, return full details with tickets
    if (order.status === 'confirmed') {
      const fullOrder = await getConfirmedOrderDetails(parseInt(req.params.orderId));
      return res.json(fullOrder);
    }

    res.json(order);
  } catch (err) {
    console.error('Error fetching order:', err);
    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// POST /api/orders/:orderId/cancel
// ============================================================
// Called when the payment timer expires or user abandons.
// Releases Redis holds (seats → AVAILABLE) and marks
// the order as FAILED in PostgreSQL.
// ============================================================
router.post('/:orderId/cancel', authenticate, async (req, res) => {
  try {
    console.log(`🔴 CANCEL called for order ${req.params.orderId} by user ${req.user.id}`);
    const result = await failOrder(parseInt(req.params.orderId), req.user.id);
    console.log(`🔴 CANCEL failOrder result:`, result);

    // Release waiting room slot
    try {
      const order = await getOrderById(parseInt(req.params.orderId), req.user.id);
      if (order) await releaseSlot(order.event_id || order.eventId, req.user.id);
    } catch {}

    // Broadcast seat releases via WebSocket
    try {
      const { broadcastMultiSeatUpdate } = require('../ws/seatBroadcast');
      const pool = require('../config/db');
      const items = await pool.query(
        `SELECT s.seat_id, o.event_id
         FROM order_items oi
         JOIN seats s ON oi.seat_id = s.seat_id
         JOIN orders o ON oi.order_id = o.order_id
         WHERE oi.order_id = $1`,
        [parseInt(req.params.orderId)]
      );
      if (items.rows.length > 0) {
        const eventId = items.rows[0].event_id;
        const seatIds = items.rows.map(r => r.seat_id);
        console.log(`🔴 CANCEL broadcasting SEAT_AVAILABLE for seats:`, seatIds, 'event:', eventId);
        broadcastMultiSeatUpdate(eventId, 'SEAT_AVAILABLE', seatIds);
      }
    } catch {}

    res.json(result);
  } catch (err) {
    console.error('Error cancelling order:', err);
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// POST /api/orders/:orderId/cancel-beacon
// ============================================================
// Same as /cancel but accepts JWT in the body instead of
// the Authorization header. Used by navigator.sendBeacon()
// which cannot set custom headers.
// ============================================================
router.post('/:orderId/cancel-beacon', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(401).json({ message: 'No token' });

    // Verify JWT manually
    const jwt = require('jsonwebtoken');
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: 'Invalid token' });
    }

    const result = await failOrder(parseInt(req.params.orderId), decoded.userId);

    // Broadcast seat releases via WebSocket
    try {
      const { broadcastMultiSeatUpdate } = require('../ws/seatBroadcast');
      const pool = require('../config/db');
      const items = await pool.query(
        `SELECT s.seat_id, o.event_id
         FROM order_items oi
         JOIN seats s ON oi.seat_id = s.seat_id
         JOIN orders o ON oi.order_id = o.order_id
         WHERE oi.order_id = $1`,
        [parseInt(req.params.orderId)]
      );
      if (items.rows.length > 0) {
        const eventId = items.rows[0].event_id;
        const seatIds = items.rows.map(r => r.seat_id);
        broadcastMultiSeatUpdate(eventId, 'SEAT_AVAILABLE', seatIds);
      }
    } catch {}

    res.json(result);
  } catch (err) {
    console.error('Error cancelling order (beacon):', err);
    res.status(500).json({ message: err.message });
  }
});


module.exports = router;