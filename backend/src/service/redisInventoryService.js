// ============================================================
// redisInventoryService.js — Redis-first seat inventory
//
// This is the core real-time seat layer. Redis is the source
// of truth for seat availability during the booking flow.
//
// Redis Key Format:
//   seat:{eventId}:{seatId} → AVAILABLE | HELD:{holdId} | FINALIZING:{holdId} | BOOKED
//
// TTL Rules:
//   AVAILABLE    → no TTL (persists)
//   HELD:{h}     → TTL = 600s (10 min selection timer)
//   FINALIZING   → no TTL (must not expire during PG commit)
//   BOOKED       → no TTL (persists forever)
//
// When a HELD key expires (TTL), Redis deletes it.
// GET returns nil → treated as AVAILABLE by getSeatMap().
//
// All multi-seat operations use Lua scripts for atomicity.
// ============================================================

const redis = require('../config/redis');

const SELECTION_TTL = 600;  // 10 minutes for seat selection
const PAYMENT_TTL = 300;    // 5 minutes for payment


// ============================================================
// Lua Scripts (loaded once, cached by Redis)
// ============================================================

// --- ACQUIRE SEATS (all-or-nothing) ---
// KEYS[1..N] = seat:{eventId}:{seatId}
// ARGV[1]    = "HELD:{holdId}"
// ARGV[2]    = TTL in seconds
// Returns 1 on success, 0 on failure
const ACQUIRE_SEATS_LUA = `
local holdValue = ARGV[1]
local ttl = tonumber(ARGV[2])

-- Phase 1: Verify ALL seats are AVAILABLE
for i = 1, #KEYS do
  local val = redis.call('GET', KEYS[i])
  if val ~= 'AVAILABLE' and val ~= false then
    return 0
  end
end

-- Phase 2: All available → acquire all atomically
for i = 1, #KEYS do
  redis.call('SET', KEYS[i], holdValue, 'EX', ttl)
end

return 1
`;

// --- RELEASE SEAT (single seat, safe) ---
// KEYS[1] = seat:{eventId}:{seatId}
// ARGV[1] = expected "HELD:{holdId}"
// Returns 1 if released, 0 if not owned
const RELEASE_SEAT_LUA = `
local val = redis.call('GET', KEYS[1])
if val == ARGV[1] then
  redis.call('SET', KEYS[1], 'AVAILABLE')
  return 1
end
return 0
`;

// --- RELEASE MULTIPLE SEATS (all belonging to holdId) ---
// KEYS[1..N] = seat keys
// ARGV[1]    = expected "HELD:{holdId}"
// Returns count of released seats
const RELEASE_SEATS_LUA = `
local expected = ARGV[1]
local released = 0
for i = 1, #KEYS do
  local val = redis.call('GET', KEYS[i])
  if val == expected then
    redis.call('SET', KEYS[i], 'AVAILABLE')
    released = released + 1
  end
end
return released
`;

// --- FINALIZE SEATS (HELD → FINALIZING, atomic) ---
// KEYS[1..N] = seat:{eventId}:{seatId}
// ARGV[1]    = expected "HELD:{holdId}"
// ARGV[2]    = "FINALIZING:{holdId}"
// Returns 1 on success, 0 if any seat doesn't match
const FINALIZE_SEATS_LUA = `
local expectedHeld = ARGV[1]
local finalizeValue = ARGV[2]

-- Phase 1: Verify ALL seats belong to this holdId
for i = 1, #KEYS do
  local val = redis.call('GET', KEYS[i])
  if val ~= expectedHeld then
    return 0
  end
end

-- Phase 2: Transition all to FINALIZING (no TTL)
for i = 1, #KEYS do
  redis.call('SET', KEYS[i], finalizeValue)
end

return 1
`;

// --- ROLLBACK FINALIZE (FINALIZING → AVAILABLE) ---
// KEYS[1..N] = seat keys
// ARGV[1]    = expected "FINALIZING:{holdId}"
// Returns count of rolled back seats
const ROLLBACK_FINALIZE_LUA = `
local expected = ARGV[1]
local rolledBack = 0
for i = 1, #KEYS do
  local val = redis.call('GET', KEYS[i])
  if val == expected then
    redis.call('SET', KEYS[i], 'AVAILABLE')
    rolledBack = rolledBack + 1
  end
end
return rolledBack
`;


// ============================================================
// Helper: build Redis key for a seat
// ============================================================
function seatKey(eventId, seatId) {
  return `seat:${eventId}:${seatId}`;
}


// ============================================================
// initializeEventSeats(eventId, seats)
// ============================================================
// Called when an event is published. Populates Redis with the
// initial state for every seat.
//
// seats: [{ seat_id, status }] — from PostgreSQL
//   status='available' → SET seat:3:42 AVAILABLE
//   status='booked'    → SET seat:3:42 BOOKED (no TTL)
// ============================================================
async function initializeEventSeats(eventId, seats) {
  const pipeline = redis.pipeline();

  for (const seat of seats) {
    const key = seatKey(eventId, seat.seat_id);
    if (seat.status === 'booked') {
      pipeline.set(key, 'BOOKED'); // no TTL — persists forever
    } else {
      pipeline.set(key, 'AVAILABLE');
    }
  }

  await pipeline.exec();
  console.log(`✅ Redis: initialized ${seats.length} seats for event ${eventId}`);
}


// ============================================================
// getSeatMap(eventId, seatIds)
// ============================================================
// Returns the real-time state of all seats for an event.
// Uses MGET for a single round-trip.
//
// seatIds: [42, 43, 44, ...] — all seat IDs for this event
//
// Returns: { [seatId]: 'AVAILABLE'|'HELD:H123'|'FINALIZING:H123'|'BOOKED' }
//
// nil (expired/missing key) → treated as AVAILABLE
// ============================================================
async function getSeatMap(eventId, seatIds) {
  if (seatIds.length === 0) return {};

  const keys = seatIds.map(id => seatKey(eventId, id));
  const values = await redis.mget(...keys);

  const result = {};
  for (let i = 0; i < seatIds.length; i++) {
    // nil → AVAILABLE (key expired or was never set)
    result[seatIds[i]] = values[i] || 'AVAILABLE';
  }

  return result;
}


// ============================================================
// acquireSeats(eventId, seatIds, holdId, ttl?)
// ============================================================
// Atomic all-or-nothing seat acquisition using Lua.
//
// Every seat must be AVAILABLE. If even one is not, none are
// acquired. Sets HELD:{holdId} with the given TTL.
//
// ttl defaults to SELECTION_TTL (600s). Pass the remaining
// session TTL to keep seat keys in sync with the session.
//
// Returns: { success: true } or { success: false, message: '...' }
// ============================================================
async function acquireSeats(eventId, seatIds, holdId, ttl = SELECTION_TTL) {
  const keys = seatIds.map(id => seatKey(eventId, id));
  const holdValue = `HELD:${holdId}`;

  const result = await redis.eval(
    ACQUIRE_SEATS_LUA,
    keys.length,
    ...keys,
    holdValue,
    String(ttl)
  );

  if (result === 1) {
    return { success: true };
  }

  return {
    success: false,
    message: 'One or more seats are no longer available',
  };
}


// ============================================================
// releaseSeat(eventId, seatId, holdId)
// ============================================================
// Releases a single seat if it belongs to the given holdId.
// Used when a customer deselects a seat.
// ============================================================
async function releaseSeat(eventId, seatId, holdId) {
  const key = seatKey(eventId, seatId);
  const holdValue = `HELD:${holdId}`;

  const result = await redis.eval(
    RELEASE_SEAT_LUA,
    1,
    key,
    holdValue
  );

  return result === 1;
}


// ============================================================
// releaseSeats(eventId, seatIds, holdId)
// ============================================================
// Releases multiple seats belonging to a holdId.
// Used on session expiry / payment failure.
// ============================================================
async function releaseSeats(eventId, seatIds, holdId) {
  if (seatIds.length === 0) return 0;

  const keys = seatIds.map(id => seatKey(eventId, id));
  const holdValue = `HELD:${holdId}`;

  const result = await redis.eval(
    RELEASE_SEATS_LUA,
    keys.length,
    ...keys,
    holdValue
  );

  return result;
}


// ============================================================
// finalizeSeats(eventId, seatIds, holdId)
// ============================================================
// Atomic HELD → FINALIZING transition using Lua.
// Every seat must be HELD:{holdId}. If any doesn't match,
// none are transitioned.
//
// FINALIZING has NO TTL — must not expire during PG commit.
// ============================================================
async function finalizeSeats(eventId, seatIds, holdId) {
  const keys = seatIds.map(id => seatKey(eventId, id));
  const heldValue = `HELD:${holdId}`;
  const finalizeValue = `FINALIZING:${holdId}`;

  const result = await redis.eval(
    FINALIZE_SEATS_LUA,
    keys.length,
    ...keys,
    heldValue,
    finalizeValue
  );

  if (result === 1) {
    return { success: true };
  }

  return {
    success: false,
    message: 'Hold expired or seats no longer belong to this session',
  };
}


// ============================================================
// confirmSeats(eventId, seatIds)
// ============================================================
// After PG commit: FINALIZING → BOOKED (no TTL, persists forever).
// Do NOT delete the key — BOOKED must remain so stale clients
// are rejected at the Redis layer.
// ============================================================
async function confirmSeats(eventId, seatIds) {
  const pipeline = redis.pipeline();

  for (const seatId of seatIds) {
    // SET without EX → no TTL → persists forever
    pipeline.set(seatKey(eventId, seatId), 'BOOKED');
  }

  await pipeline.exec();
}


// ============================================================
// rollbackFinalize(eventId, seatIds, holdId)
// ============================================================
// If PG commit fails: FINALIZING → AVAILABLE using Lua.
// Only rolls back seats that still have FINALIZING:{holdId}.
// ============================================================
async function rollbackFinalize(eventId, seatIds, holdId) {
  if (seatIds.length === 0) return 0;

  const keys = seatIds.map(id => seatKey(eventId, id));
  const finalizeValue = `FINALIZING:${holdId}`;

  const result = await redis.eval(
    ROLLBACK_FINALIZE_LUA,
    keys.length,
    ...keys,
    finalizeValue
  );

  return result;
}


module.exports = {
  initializeEventSeats,
  getSeatMap,
  acquireSeats,
  releaseSeat,
  releaseSeats,
  finalizeSeats,
  confirmSeats,
  rollbackFinalize,
  seatKey,
  SELECTION_TTL,
  PAYMENT_TTL,
};
