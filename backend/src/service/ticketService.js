// ============================================================
// ticketService.js — Ticket retrieval for customers
//
// Provides read operations for the My Tickets page and
// individual ticket views. Write operations (ticket creation)
// happen inside orderService.confirmOrder().
// ============================================================

const pool = require('../config/db');


// ============================================================
// getMyTickets(customerId)
// ============================================================
// Returns all tickets for a customer, grouped by order/event.
// Used by the "My Tickets" page.
// ============================================================
async function getMyTickets(customerId) {
  const result = await pool.query(
    `SELECT t.ticket_id, t.price, t.qr_code, t.checked_in, t.created_at,
            s.section, s.row_label, s.seat_number,
            o.order_id, o.status AS order_status,
            e.event_id, e.event_name, e.event_start_time, e.event_end_time,
            e.status AS event_status,
            v.venue_name,
            c.city_name
     FROM tickets t
     JOIN orders o ON t.order_id = o.order_id
     JOIN seats s ON t.seat_id = s.seat_id
     JOIN events e ON o.event_id = e.event_id
     JOIN venues v ON e.venue_id = v.venue_id
     LEFT JOIN cities c ON v.city_id = c.city_id
     WHERE o.customer_id = $1 AND o.status = 'confirmed'
     ORDER BY e.event_start_time DESC, s.section, s.row_label, s.seat_number`,
    [customerId]
  );

  // Group tickets by order
  const ordersMap = {};

  for (const row of result.rows) {
    if (!ordersMap[row.order_id]) {
      ordersMap[row.order_id] = {
        orderId: row.order_id,
        eventId: row.event_id,
        eventName: row.event_name,
        eventStartTime: row.event_start_time,
        eventEndTime: row.event_end_time,
        eventStatus: row.event_status,
        venueName: row.venue_name,
        cityName: row.city_name,
        tickets: [],
      };
    }

    ordersMap[row.order_id].tickets.push({
      ticketId: row.ticket_id,
      section: row.section,
      row: row.row_label,
      seatNumber: row.seat_number,
      price: parseFloat(row.price),
      qrCode: row.qr_code,
      checkedIn: row.checked_in,
    });
  }

  return Object.values(ordersMap);
}


// ============================================================
// getTicketById(ticketId, customerId)
// ============================================================
// Returns a single ticket with full details (for QR display).
// ============================================================
async function getTicketById(ticketId, customerId) {
  const result = await pool.query(
    `SELECT t.ticket_id, t.price, t.qr_code, t.checked_in, t.created_at,
            s.section, s.row_label, s.seat_number,
            o.order_id,
            e.event_id, e.event_name, e.event_start_time,
            v.venue_name
     FROM tickets t
     JOIN orders o ON t.order_id = o.order_id
     JOIN seats s ON t.seat_id = s.seat_id
     JOIN events e ON o.event_id = e.event_id
     JOIN venues v ON e.venue_id = v.venue_id
     WHERE t.ticket_id = $1 AND o.customer_id = $2`,
    [ticketId, customerId]
  );

  if (result.rows.length === 0) return null;

  const t = result.rows[0];
  return {
    ticketId: t.ticket_id,
    orderId: t.order_id,
    eventId: t.event_id,
    eventName: t.event_name,
    eventStartTime: t.event_start_time,
    venueName: t.venue_name,
    section: t.section,
    row: t.row_label,
    seatNumber: t.seat_number,
    price: parseFloat(t.price),
    qrCode: t.qr_code,
    checkedIn: t.checked_in,
  };
}


module.exports = { getMyTickets, getTicketById };
