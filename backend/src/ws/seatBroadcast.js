// ============================================================
// seatBroadcast.js — WebSocket server for real-time seat updates
//
// Provides real-time seat state changes to connected clients.
// This is ONLY for UI freshness — it does NOT enforce correctness.
// Redis/PostgreSQL enforce all seat operations regardless of
// whether a client receives the WebSocket update.
//
// PROTOCOL:
//   Client connects: ws://localhost:5000/ws/seats/:eventId
//
//   Server sends:
//     { type: 'SEAT_HELD',      seatId: 42, section: 'VIP' }
//     { type: 'SEAT_AVAILABLE', seatId: 42, section: 'VIP' }
//     { type: 'SEAT_BOOKED',    seatId: 42, section: 'VIP' }
//
// ARCHITECTURE NOTE:
//   Even if a client misses a WebSocket update, the backend
//   always validates against Redis before allowing acquisition.
// ============================================================

const { WebSocketServer } = require('ws');
const url = require('url');

let wss = null;

// Map of eventId → Set<WebSocket>
const eventRooms = new Map();


// ============================================================
// initWebSocket(server)
// ============================================================
// Attach the WebSocket server to the existing HTTP server.
// Called from server.js after app.listen().
// ============================================================
function initWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // Parse eventId from URL: /ws?eventId=3
    const params = new URL(req.url, `http://${req.headers.host}`);
    const eventId = params.searchParams.get('eventId');

    if (!eventId) {
      ws.close(4000, 'eventId query param required');
      return;
    }

    // Join the event room
    if (!eventRooms.has(eventId)) {
      eventRooms.set(eventId, new Set());
    }
    eventRooms.get(eventId).add(ws);

    // Handle disconnect
    ws.on('close', () => {
      const room = eventRooms.get(eventId);
      if (room) {
        room.delete(ws);
        if (room.size === 0) {
          eventRooms.delete(eventId);
        }
      }
    });

    // Send initial acknowledgment
    ws.send(JSON.stringify({
      type: 'CONNECTED',
      eventId,
      message: 'Real-time seat updates active',
    }));
  });

  console.log('🔌 WebSocket server attached');
}


// ============================================================
// broadcastSeatUpdate(eventId, type, seatId, section)
// ============================================================
// Broadcasts a seat state change to all clients watching
// the given event.
//
// type: 'SEAT_HELD' | 'SEAT_AVAILABLE' | 'SEAT_BOOKED'
// ============================================================
function broadcastSeatUpdate(eventId, type, seatId, section = '') {
  const room = eventRooms.get(String(eventId));
  if (!room || room.size === 0) return;

  const message = JSON.stringify({
    type,
    seatId,
    section,
    timestamp: Date.now(),
  });

  for (const ws of room) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(message);
    }
  }
}


// ============================================================
// broadcastMultiSeatUpdate(eventId, type, seatIds)
// ============================================================
// Broadcasts state changes for multiple seats at once.
// ============================================================
function broadcastMultiSeatUpdate(eventId, type, seatIds) {
  const room = eventRooms.get(String(eventId));
  if (!room || room.size === 0) return;

  const message = JSON.stringify({
    type,
    seatIds,
    timestamp: Date.now(),
  });

  for (const ws of room) {
    if (ws.readyState === 1) {
      ws.send(message);
    }
  }
}


module.exports = {
  initWebSocket,
  broadcastSeatUpdate,
  broadcastMultiSeatUpdate,
};
