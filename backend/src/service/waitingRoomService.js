// ============================================================
// waitingRoomService.js — Queue management for high-demand events
//
// Uses Redis Sorted Sets to manage a FIFO queue per event.
// When more customers want to buy tickets than the system can
// handle simultaneously, excess customers are placed in a
// waiting room queue and admitted in order (FCFS).
//
// ARCHITECTURE:
//   - Redis Sorted Set: waiting_room:{eventId}
//     Score = join timestamp (ms), Value = customerId
//     → FIFO ordering by join time
//
//   - Redis Sorted Set: admitted:{eventId}
//     Score = expiry timestamp (ms), Value = customerId
//     → Self-cleaning: expired members are swept before every
//       count check, so abandoned sessions can never permanently
//       occupy a slot.
//
//   - Threshold: max concurrent buyers per event (default: 200)
//     Stored in Redis as: waiting_room_config:{eventId}
//
// FLOW:
//   1. Customer clicks "Buy Tickets"
//   2. Backend checks: admitted count < threshold?
//      YES → admit immediately, redirect to seat map
//      NO  → add to waiting room queue, show position
//   3. When a buyer finishes (payment or timeout), call releaseSlot()
//   4. releaseSlot() admits the next person from the queue
//   5. Frontend polls getPosition() every few seconds
//
// PREVIOUS BUG (fixed):
//   The old design used a Redis Set for admitted members plus a
//   separate per-member TTL key (admitted_ttl:{eventId}:{customerId}).
//   When the TTL key expired, Redis deleted it silently but the
//   member stayed in the Set permanently — a "ghost slot" leak.
//
//   The new design uses a single Sorted Set where the score IS
//   the expiry timestamp. Every admission check sweeps out expired
//   members first (ZREMRANGEBYSCORE), so membership and expiry
//   can never drift out of sync.
// ============================================================

const redis = require('../config/redis');

const DEFAULT_THRESHOLD = 3; // max concurrent buyers
const ADMITTED_TTL = 600;       // 10 minutes to complete purchase (seconds)


// ============================================================
// getThreshold(eventId)
// ============================================================
// Returns the max concurrent buyers for an event.
// Falls back to DEFAULT_THRESHOLD if not configured.
// ============================================================
async function getThreshold(eventId) {
  const val = await redis.get(`waiting_room_config:${eventId}`);
  return val ? parseInt(val) : DEFAULT_THRESHOLD;
}


// ============================================================
// setThreshold(eventId, threshold)
// ============================================================
// Organizer can configure the threshold per event.
// ============================================================
async function setThreshold(eventId, threshold) {
  await redis.set(`waiting_room_config:${eventId}`, String(threshold));
}


// ============================================================
// sweepExpired(eventId)
// ============================================================
// Removes all expired members from admitted:{eventId}.
// Called before every count check so ghost slots are cleaned
// automatically — no background job or TTL callback needed.
// ============================================================
async function sweepExpired(eventId) {
  await redis.zremrangebyscore(`admitted:${eventId}`, '-inf', Date.now());
}


// ============================================================
// tryAdmit(eventId, customerId)
// ============================================================
// Main entry point. Checks if the customer can be admitted
// immediately or needs to wait in the queue.
//
// Returns:
//   { admitted: true }  → go to seat map
//   { admitted: false, position: 5, totalInQueue: 42 }  → wait
// ============================================================
async function tryAdmit(eventId, customerId) {
  const customerStr = String(customerId);

  // Sweep expired members first
  await sweepExpired(eventId);

  // Already admitted and not expired? Let them through.
  const existingScore = await redis.zscore(`admitted:${eventId}`, customerStr);
  if (existingScore !== null && Number(existingScore) > Date.now()) {
    return { admitted: true };
  }

  // Check how many are currently admitted (post-sweep)
  const admittedCount = await redis.zcard(`admitted:${eventId}`);
  const threshold = await getThreshold(eventId);

  if (admittedCount < threshold) {
    // Room available — admit immediately
    const expiresAt = Date.now() + (ADMITTED_TTL * 1000);
    await redis.zadd(`admitted:${eventId}`, expiresAt, customerStr);
    return { admitted: true };
  }

  // Queue is full — add to waiting room (if not already there)
  const score = await redis.zscore(`waiting_room:${eventId}`, customerStr);
  if (!score) {
    await redis.zadd(`waiting_room:${eventId}`, Date.now(), customerStr);
  }

  // Get their position
  const position = await redis.zrank(`waiting_room:${eventId}`, customerStr);
  const totalInQueue = await redis.zcard(`waiting_room:${eventId}`);

  return {
    admitted: false,
    position: (position !== null ? position + 1 : totalInQueue), // 1-based
    totalInQueue,
  };
}


// ============================================================
// getPosition(eventId, customerId)
// ============================================================
// Returns current queue status for polling.
// If admitted in the meantime, returns { admitted: true }.
// ============================================================
async function getPosition(eventId, customerId) {
  const customerStr = String(customerId);

  // Sweep expired members first
  await sweepExpired(eventId);

  // Check if admitted (and not expired)
  const existingScore = await redis.zscore(`admitted:${eventId}`, customerStr);
  if (existingScore !== null && Number(existingScore) > Date.now()) {
    return { admitted: true };
  }

  // Check queue position
  const position = await redis.zrank(`waiting_room:${eventId}`, customerStr);
  if (position === null) {
    // Not in queue and not admitted — try to admit
    return tryAdmit(eventId, customerId);
  }

  const totalInQueue = await redis.zcard(`waiting_room:${eventId}`);

  return {
    admitted: false,
    position: position + 1, // 1-based
    totalInQueue,
  };
}


// ============================================================
// releaseSlot(eventId, customerId)
// ============================================================
// Called when a customer finishes buying (payment success/fail)
// or abandons. Removes them from the admitted sorted set and
// admits the next person from the queue.
// ============================================================
async function releaseSlot(eventId, customerId) {
  const customerStr = String(customerId);

  // Remove from admitted sorted set
  await redis.zrem(`admitted:${eventId}`, customerStr);

  // Also remove from queue if they were there
  await redis.zrem(`waiting_room:${eventId}`, customerStr);

  // Sweep expired members while we're here
  await sweepExpired(eventId);

  // Admit the next person from the queue
  const next = await redis.zrange(`waiting_room:${eventId}`, 0, 0);
  if (next && next.length > 0) {
    const nextCustomer = next[0];
    await redis.zrem(`waiting_room:${eventId}`, nextCustomer);
    const expiresAt = Date.now() + (ADMITTED_TTL * 1000);
    await redis.zadd(`admitted:${eventId}`, expiresAt, nextCustomer);
  }

  return { released: true };
}


// ============================================================
// isAdmitted(eventId, customerId)
// ============================================================
// Quick check — used by seat lock endpoint to verify the
// customer is admitted before allowing seat selection.
// ============================================================
async function isAdmitted(eventId, customerId) {
  const score = await redis.zscore(`admitted:${eventId}`, String(customerId));
  // Admitted only if present AND not expired
  return score !== null && Number(score) > Date.now();
}


module.exports = {
  tryAdmit,
  getPosition,
  releaseSlot,
  isAdmitted,
  setThreshold,
  getThreshold,
  DEFAULT_THRESHOLD,
};
