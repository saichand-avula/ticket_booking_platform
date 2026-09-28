// ============================================================
// bookingSessionService.js — Selection session management
//
// When a customer enters the seat selection page, a booking
// session is created. The session contains:
//
//   - sessionId (unique)
//   - holdId (unique — used as the Redis HELD value)
//   - userId
//   - eventId
//   - selectedSeats (track which seats this session holds)
//   - expiresAt (server-enforced, 10 min)
//
// Stored in Redis with TTL = 600s (10 min selection timer).
//
// Key: session:{sessionId}
// Value: JSON string of session data
//
// The frontend timer is display-only. The server enforces
// expiration using this Redis key's TTL.
// ============================================================

const redis = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const { SELECTION_TTL } = require('./redisInventoryService');


// ============================================================
// createSession(userId, eventId)
// ============================================================
// Creates a new booking session with a unique holdId.
// Returns { sessionId, holdId, expiresAt, ttl }
// ============================================================
async function createSession(userId, eventId) {
  const sessionId = `S${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const holdId = `H${uuidv4().replace(/-/g, '').slice(0, 12)}`;

  const session = {
    sessionId,
    holdId,
    userId: String(userId),
    eventId: String(eventId),
    selectedSeats: [],  // seatIds currently held
    createdAt: Date.now(),
    expiresAt: Date.now() + (SELECTION_TTL * 1000),
  };

  await redis.set(
    `session:${sessionId}`,
    JSON.stringify(session),
    'EX',
    SELECTION_TTL
  );

  return {
    sessionId,
    holdId,
    expiresAt: session.expiresAt,
    ttl: SELECTION_TTL,
  };
}


// ============================================================
// getSession(sessionId)
// ============================================================
// Returns the session data or null if expired/missing.
// ============================================================
async function getSession(sessionId) {
  const raw = await redis.get(`session:${sessionId}`);
  if (!raw) return null;
  return JSON.parse(raw);
}


// ============================================================
// validateSession(sessionId, userId)
// ============================================================
// Validates that:
//   1. Session exists (not expired)
//   2. Session belongs to this user
//
// Returns { valid: true, session } or { valid: false, message }
// ============================================================
async function validateSession(sessionId, userId) {
  const session = await getSession(sessionId);

  if (!session) {
    return { valid: false, message: 'Session expired or not found' };
  }

  if (session.userId !== String(userId)) {
    return { valid: false, message: 'Session does not belong to this user' };
  }

  return { valid: true, session };
}


// ============================================================
// addSeatToSession(sessionId, seatId)
// ============================================================
// Adds a seat ID to the session's selectedSeats list.
// Called after successful Redis acquisition.
// Refreshes TTL to maintain remaining time.
// ============================================================
async function addSeatToSession(sessionId, seatId) {
  const session = await getSession(sessionId);
  if (!session) return false;

  if (!session.selectedSeats.includes(seatId)) {
    session.selectedSeats.push(seatId);
  }

  // Get remaining TTL and preserve it
  const ttl = await redis.ttl(`session:${sessionId}`);
  if (ttl > 0) {
    await redis.set(
      `session:${sessionId}`,
      JSON.stringify(session),
      'EX',
      ttl
    );
  }

  return true;
}


// ============================================================
// removeSeatFromSession(sessionId, seatId)
// ============================================================
// Removes a seat ID from the session's selectedSeats list.
// Called after successful Redis release.
// ============================================================
async function removeSeatFromSession(sessionId, seatId) {
  const session = await getSession(sessionId);
  if (!session) return false;

  session.selectedSeats = session.selectedSeats.filter(
    id => String(id) !== String(seatId)
  );

  const ttl = await redis.ttl(`session:${sessionId}`);
  if (ttl > 0) {
    await redis.set(
      `session:${sessionId}`,
      JSON.stringify(session),
      'EX',
      ttl
    );
  }

  return true;
}


// ============================================================
// deleteSession(sessionId)
// ============================================================
// Explicitly removes a session (e.g., after proceeding to payment).
// ============================================================
async function deleteSession(sessionId) {
  await redis.del(`session:${sessionId}`);
}


module.exports = {
  createSession,
  getSession,
  validateSession,
  addSeatToSession,
  removeSeatFromSession,
  deleteSession,
};
