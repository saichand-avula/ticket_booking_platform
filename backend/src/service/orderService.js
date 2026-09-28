// ============================================================
// orderService.js — Order creation and finalization
//
// FLOW:
//   1. createOrder(userId, eventId, seatIds, holdId, sessionId)
//      → creates PENDING_PAYMENT order in PostgreSQL
//      → creates Razorpay order
//
//   2. confirmOrder(orderId, userId, razorpayPayment)
//      → validates hold + payment timer
//      → Lua: HELD → FINALIZING (atomic)
//      → short PG TX: lock seats, verify AVAILABLE, → BOOKED
//      → Redis: FINALIZING → BOOKED
//      → generates tickets + QR codes
//
//   3. failOrder(orderId, userId)
//      → releases Redis holds
//      → marks order as FAILED
//
// IDEMPOTENCY:
//   If an order is already CONFIRMED, confirmOrder returns the
//   existing booking without creating duplicates.
//
// NEVER keeps a PG transaction open during payment.
// ============================================================

const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const {
  finalizeSeats,
  confirmSeats,
  rollbackFinalize,
  releaseSeats,
} = require('./redisInventoryService');
const { generateQRCode } = require('./qrCodeService');
const redis = require('../config/redis');


// ============================================================
// createOrder(userId, eventId, seatIds, holdId, sessionId)
// ============================================================
// Creates a PENDING_PAYMENT order with frozen prices.
// Does NOT touch Redis or finalize anything yet.
// ============================================================
async function createOrder(userId, eventId, seatIds, holdId, sessionId) {
  // Get seat prices (frozen at checkout time)
  const seatResult = await pool.query(
    `SELECT seat_id, section, row_label, seat_number, price
     FROM seats
     WHERE seat_id = ANY($1) AND event_id = $2`,
    [seatIds, eventId]
  );

  if (seatResult.rows.length !== seatIds.length) {
    throw new Error('Some seats not found');
  }

  const totalAmount = seatResult.rows.reduce(
    (sum, s) => sum + parseFloat(s.price), 0
  );

  const idempotencyKey = uuidv4();

  // Insert order
  const orderResult = await pool.query(
    `INSERT INTO orders (customer_id, event_id, status, total_amount, idempotency_key)
     VALUES ($1, $2, 'pending', $3, $4)
     RETURNING order_id`,
    [userId, eventId, totalAmount, idempotencyKey]
  );

  const orderId = orderResult.rows[0].order_id;

  // Insert order items (frozen prices)
  for (const seat of seatResult.rows) {
    await pool.query(
      `INSERT INTO order_items (order_id, seat_id, price_at_purchase)
       VALUES ($1, $2, $3)`,
      [orderId, seat.seat_id, seat.price]
    );
  }

  // Store order metadata in Redis for payment phase validation
  await redis.set(
    `order_meta:${orderId}`,
    JSON.stringify({
      orderId,
      userId: String(userId),
      eventId: String(eventId),
      holdId,
      sessionId,
      seatIds,
      totalAmount,
      createdAt: Date.now(),
    }),
    'EX',
    600 // 10 min safety margin
  );

  return {
    orderId,
    eventId,
    holdId,
    totalAmount,
    seats: seatResult.rows,
    idempotencyKey,
  };
}


// ============================================================
// confirmOrder(orderId, userId)
// ============================================================
// Called AFTER payment succeeds. Performs:
//   1. Idempotency check (already confirmed? return existing)
//   2. Validate hold + payment timer
//   3. Lua: HELD → FINALIZING (atomic)
//   4. Short PG TX: seats AVAILABLE → BOOKED, create tickets
//   5. Redis: FINALIZING → BOOKED (persists forever)
//
// NEVER opens PG TX during payment.
// ============================================================
async function confirmOrder(orderId, userId) {
  // ---- Step 0: Idempotency ----
  const existingOrder = await pool.query(
    `SELECT order_id, status FROM orders WHERE order_id = $1 AND customer_id = $2`,
    [orderId, userId]
  );

  if (existingOrder.rows.length === 0) {
    throw new Error('Order not found');
  }

  if (existingOrder.rows[0].status === 'confirmed') {
    // Already confirmed — return existing booking (idempotent)
    return getConfirmedOrderDetails(orderId);
  }

  if (existingOrder.rows[0].status !== 'pending') {
    throw new Error(`Order is ${existingOrder.rows[0].status}, cannot confirm`);
  }

  // ---- Step 1: Get order metadata from Redis ----
  const metaRaw = await redis.get(`order_meta:${orderId}`);
  if (!metaRaw) {
    throw new Error('Order metadata expired — session timed out');
  }
  const meta = JSON.parse(metaRaw);

  // Validate user ownership
  if (meta.userId !== String(userId)) {
    throw new Error('Order does not belong to this user');
  }

  // ---- Step 2: Check payment timer ----
  const paymentTimer = await redis.get(`payment_timer:${meta.sessionId}`);
  if (!paymentTimer) {
    // Payment timer expired — release holds and fail order
    await releaseSeats(meta.eventId, meta.seatIds, meta.holdId);
    await pool.query(
      `UPDATE orders SET status = 'expired', updated_at = now() WHERE order_id = $1`,
      [orderId]
    );
    throw new Error('Payment timer expired. Seats have been released.');
  }

  // ---- Step 3: Lua — HELD → FINALIZING (atomic) ----
  const finalizeResult = await finalizeSeats(meta.eventId, meta.seatIds, meta.holdId);

  if (!finalizeResult.success) {
    // Hold expired or stolen — fail the order
    await pool.query(
      `UPDATE orders SET status = 'failed', updated_at = now() WHERE order_id = $1`,
      [orderId]
    );
    throw new Error('Seat holds expired. Cannot finalize booking.');
  }

  // ---- Step 4: Short PostgreSQL transaction ----
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock seat rows — short lock, no external calls
    const lockResult = await client.query(
      `SELECT seat_id, status, version
       FROM seats
       WHERE seat_id = ANY($1) AND event_id = $2
       FOR UPDATE`,
      [meta.seatIds, meta.eventId]
    );

    // Verify ALL seats are AVAILABLE in PostgreSQL
    const allAvailable = lockResult.rows.every(s => s.status === 'available');
    if (!allAvailable || lockResult.rows.length !== meta.seatIds.length) {
      await client.query('ROLLBACK');
      // Rollback Redis FINALIZING → AVAILABLE
      await rollbackFinalize(meta.eventId, meta.seatIds, meta.holdId);
      await pool.query(
        `UPDATE orders SET status = 'failed', updated_at = now() WHERE order_id = $1`,
        [orderId]
      );
      throw new Error('Seats no longer available in database');
    }

    // UPDATE seats → BOOKED
    await client.query(
      `UPDATE seats
       SET status = 'booked', version = version + 1
       WHERE seat_id = ANY($1) AND event_id = $2 AND status = 'available'`,
      [meta.seatIds, meta.eventId]
    );

    // UPDATE order → CONFIRMED
    await client.query(
      `UPDATE orders SET status = 'confirmed', updated_at = now() WHERE order_id = $1`,
      [orderId]
    );

    // INSERT tickets + QR codes
    for (const seatId of meta.seatIds) {
      const qrData = JSON.stringify({
        orderId,
        seatId,
        eventId: meta.eventId,
        ts: Date.now(),
      });
      const qrCode = await generateQRCode(qrData);

      await client.query(
        `INSERT INTO tickets (order_id, seat_id, price, qr_code)
         VALUES ($1, $2,
           (SELECT price FROM seats WHERE seat_id = $2),
           $3)`,
        [orderId, seatId, qrCode]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // Rollback Redis FINALIZING → AVAILABLE
    await rollbackFinalize(meta.eventId, meta.seatIds, meta.holdId);
    throw err;
  } finally {
    client.release();
  }

  // ---- Step 5: Redis — FINALIZING → BOOKED (persists forever) ----
  await confirmSeats(meta.eventId, meta.seatIds);

  // Broadcast SEAT_BOOKED to all connected clients
  const { broadcastMultiSeatUpdate } = require('../ws/seatBroadcast');
  broadcastMultiSeatUpdate(meta.eventId, 'SEAT_BOOKED', meta.seatIds);

  // Cleanup Redis metadata
  await redis.del(`order_meta:${orderId}`);
  await redis.del(`payment_timer:${meta.sessionId}`);

  return getConfirmedOrderDetails(orderId);
}


// ============================================================
// failOrder(orderId, userId)
// ============================================================
// Called on payment failure. Releases Redis holds and marks
// the order as FAILED.
// ============================================================
async function failOrder(orderId, userId) {
  const metaRaw = await redis.get(`order_meta:${orderId}`);
  console.log(`🔴 failOrder(${orderId}): order_meta exists=${!!metaRaw}`);

  if (metaRaw) {
    const meta = JSON.parse(metaRaw);
    console.log(`🔴 failOrder: holdId=${meta.holdId}, seatIds=${meta.seatIds}, eventId=${meta.eventId}`);
    // Release Redis holds
    const released = await releaseSeats(meta.eventId, meta.seatIds, meta.holdId);
    console.log(`🔴 failOrder: releaseSeats returned ${released}`);
    // Cleanup Redis
    await redis.del(`order_meta:${orderId}`);
    await redis.del(`payment_timer:${meta.sessionId}`);
    await redis.del(`session:${meta.sessionId}`); // Delete selection cache
  }

  await pool.query(
    `UPDATE orders SET status = 'failed', updated_at = now() WHERE order_id = $1 AND customer_id = $2`,
    [orderId, userId]
  );

  return { orderId, status: 'failed' };
}


// ============================================================
// getConfirmedOrderDetails(orderId)
// ============================================================
// Returns full order + ticket details for confirmed orders.
// Used for idempotent responses and confirmation page.
// ============================================================
async function getConfirmedOrderDetails(orderId) {
  const orderResult = await pool.query(
    `SELECT o.order_id, o.event_id, o.status, o.total_amount, o.created_at,
            e.event_name, v.venue_name
     FROM orders o
     JOIN events e ON o.event_id = e.event_id
     JOIN venues v ON e.venue_id = v.venue_id
     WHERE o.order_id = $1`,
    [orderId]
  );

  if (orderResult.rows.length === 0) {
    throw new Error('Order not found');
  }

  const ticketResult = await pool.query(
    `SELECT t.ticket_id, t.seat_id, t.price, t.qr_code,
            s.section, s.row_label, s.seat_number
     FROM tickets t
     JOIN seats s ON t.seat_id = s.seat_id
     WHERE t.order_id = $1`,
    [orderId]
  );

  return {
    orderId: orderResult.rows[0].order_id,
    eventId: orderResult.rows[0].event_id,
    eventName: orderResult.rows[0].event_name,
    venueName: orderResult.rows[0].venue_name,
    status: orderResult.rows[0].status,
    totalAmount: parseFloat(orderResult.rows[0].total_amount),
    createdAt: orderResult.rows[0].created_at,
    tickets: ticketResult.rows.map(t => ({
      ticketId: t.ticket_id,
      seatId: t.seat_id,
      section: t.section,
      row: t.row_label,
      seatNumber: t.seat_number,
      price: parseFloat(t.price),
      qrCode: t.qr_code,
    })),
  };
}


// ============================================================
// getOrderById(orderId, userId)
// ============================================================
async function getOrderById(orderId, userId) {
  const result = await pool.query(
    `SELECT o.*, e.event_name
     FROM orders o
     JOIN events e ON o.event_id = e.event_id
     WHERE o.order_id = $1 AND o.customer_id = $2`,
    [orderId, userId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    orderId: row.order_id,
    eventId: row.event_id,
    eventName: row.event_name,
    status: row.status,
    totalAmount: parseFloat(row.total_amount),
  };
}


module.exports = {
  createOrder,
  confirmOrder,
  failOrder,
  getConfirmedOrderDetails,
  getOrderById,
};
