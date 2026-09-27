// ============================================================
// server.js — Application entry point
//
// This file's ONLY job is to:
//   1. Set up the Express app
//   2. Wire in global middleware (CORS, JSON parsing)
//   3. Mount route files under their URL prefixes
//   4. Start listening on a port
//
// Actual business logic (queries, request handling) lives in
// controllers/routes — not here. This keeps the entry point
// clean and makes it easy to see the full URL structure of
// the API at a glance.
//
// URL STRUCTURE:
//   /health             → liveness check
//   /health/db          → database connectivity check
//   /api/auth/...       → signup and login for customers & organizers
//   /api/cities/...     → city lookup list (for dropdowns)
//   /api/venues/...     → venue CRUD (create, list, get)
//   /api/events/...     → event CRUD, publish, pricing
// ============================================================

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const pool = require('./src/config/db');

const app = express();

// ============================================================
// GLOBAL MIDDLEWARE
// ============================================================

// Lets the Next.js frontend (running on a different port/origin
// during development) make requests to this API without the
// browser blocking them. In production, you'd want to restrict
// this to your actual frontend domain.
app.use(cors());

// Parses incoming JSON request bodies (e.g. login credentials,
// order payloads) into req.body. Without this, req.body is
// undefined on POST requests.
app.use(express.json());


// ============================================================
// HEALTH CHECK ROUTES
// ============================================================

// A simple liveness check — hitting this tells you the server
// process is up at all, independent of whether the database is
// reachable. Useful for Railway/Render health checks later too.
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// A second check that actually round-trips to Postgres, so you
// can tell "server is up" apart from "server is up AND can reach
// the database" — the two failure modes need different fixes.
app.get('/health/db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'ok', db_time: result.rows[0].now });
  } catch (err) {
    console.error('DB health check failed:', err);
    res.status(500).json({ status: 'error', message: 'Database unreachable' });
  }
});


// ============================================================
// API ROUTES
// ============================================================
// Each route file is mounted under a URL prefix. The route
// file itself defines the sub-paths (e.g., eventRoutes defines
// '/:eventId/publish', which becomes '/api/events/:eventId/publish'
// after mounting here).
// ============================================================

// Auth routes — signup/login for customers and organizers.
// No authentication required on these (you can't be logged in
// before you've signed up).
app.use('/api/auth', require('./src/routes/authRoutes'));

// City routes — lookup list for dropdowns (venue creation,
// customer signup, event listing filter). Public, no auth
// required — the signup page needs this before a token exists.
app.use('/api/cities', require('./src/routes/cityRoutes'));

// Venue routes — create, list, and view venues.
// Creating requires organizer role; viewing is any authenticated user.
app.use('/api/venues', require('./src/routes/venueRoutes'));

// Event routes — create, list, view, publish, and update pricing.
// Creating/publishing/pricing requires organizer role;
// listing/viewing is any authenticated user.
app.use('/api/events', require('./src/routes/eventRoutes'));

// Seat routes — nested under events (Redis-only seat map reads).
// GET /api/events/:eventId/seats → seat map with real-time state from Redis
app.use('/api/events/:eventId/seats', require('./src/routes/seatRoutes'));

// Booking session routes — seat selection + acquisition.
// POST   /api/events/:eventId/booking-sessions         → create session
// POST   /api/booking-sessions/:sessionId/seats/:seatId → select seat (Redis Lua)
// DELETE /api/booking-sessions/:sessionId/seats/:seatId → deselect seat
// POST   /api/booking-sessions/:sessionId/proceed       → proceed to payment
// GET    /api/booking-sessions/:sessionId               → session status
app.use('/api', require('./src/routes/bookingSessionRoutes'));

// Waiting room routes — queue management for high-demand events.
// POST /api/events/:eventId/waiting-room/join → try to get admitted
// GET  /api/events/:eventId/waiting-room/position → poll queue position
// POST /api/events/:eventId/waiting-room/release → free up slot
app.use('/api/events/:eventId/waiting-room', require('./src/routes/waitingRoomRoutes'));

// Order routes — create order + Razorpay, verify payment + finalize.
// POST /api/orders → create order + Razorpay order
// POST /api/orders/:orderId/pay → verify + Lua finalize + PG TX + confirm
app.use('/api/orders', require('./src/routes/orderRoutes'));

// Ticket routes — retrieve customer's tickets with QR codes.
// GET /api/tickets/my → all tickets
// GET /api/tickets/:ticketId → single ticket
app.use('/api/tickets', require('./src/routes/ticketRoutes'));


// ============================================================
// START SERVER + WebSocket
// ============================================================
const { initWebSocket } = require('./src/ws/seatBroadcast');
const PORT = process.env.PORT || 8002;

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Attach WebSocket server to the same HTTP server
initWebSocket(server);