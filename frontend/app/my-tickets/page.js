// ============================================================
// My Tickets Page — /my-tickets
//
// Lists all the customer's confirmed tickets grouped by event.
// Each ticket shows section, row, seat, price, and QR code.
//
// API: GET /api/tickets/my
// ============================================================

'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

export default function MyTicketsPage() {
  const { user, loading: authLoading } = useAuth();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (authLoading) return;

    async function fetchTickets() {
      try {
        const data = await api.get('/tickets/my');
        setOrders(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    fetchTickets();
  }, [authLoading]);

  // Format date
  function formatDate(dateStr) {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  }

  // Is event upcoming?
  function isUpcoming(startTime) {
    return new Date(startTime) > new Date();
  }

  if (loading) {
    return (
      <div className="page-container py-20 text-center">
        <div className="spinner mx-auto mb-4" style={{ width: 40, height: 40 }}></div>
        <p style={{ color: 'var(--text-muted)' }}>Loading your tickets...</p>
      </div>
    );
  }

  return (
    <div className="page-container py-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">My Tickets</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {orders.length === 0 ? 'No tickets yet' : `${orders.length} booking${orders.length > 1 ? 's' : ''}`}
        </p>
      </div>

      {error && <div className="error-message mb-4">{error}</div>}

      {orders.length === 0 && !error && (
        <div className="text-center py-20">
          <div className="text-5xl mb-4">🎫</div>
          <h3 className="text-xl font-semibold mb-2">No tickets yet</h3>
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
            Browse events and book your first tickets!
          </p>
          <Link href="/events" className="btn-primary no-underline">Browse Events</Link>
        </div>
      )}

      <div className="flex flex-col gap-6 max-w-2xl">
        {orders.map(order => (
          <div key={order.orderId} className="card p-5">
            {/* Event Header */}
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold">{order.eventName}</h2>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  📍 {order.venueName}{order.cityName ? `, ${order.cityName}` : ''}
                </p>
                <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                  📅 {formatDate(order.eventStartTime)}
                </p>
              </div>
              <span className={`badge ${isUpcoming(order.eventStartTime) ? 'badge-published' : 'badge-closed'}`}>
                {isUpcoming(order.eventStartTime) ? 'Upcoming' : 'Past'}
              </span>
            </div>

            {/* Tickets Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {order.tickets.map((ticket, idx) => (
                <div key={ticket.ticketId}
                  className="p-3 rounded-lg flex items-center gap-3"
                  style={{ background: 'var(--bg-secondary)' }}>

                  {/* QR Code (small) */}
                  {ticket.qrCode && (
                    <img
                      src={ticket.qrCode}
                      alt="QR"
                      className="rounded flex-shrink-0"
                      style={{ width: 60, height: 60 }}
                    />
                  )}

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm">{ticket.section}</div>
                    <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      Row {ticket.row} · Seat {ticket.seatNumber}
                    </div>
                    <div className="text-xs font-bold mt-1">₹{ticket.price.toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Order Footer */}
            <div className="mt-3 pt-3 flex items-center justify-between text-xs"
              style={{ borderTop: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
              <span>Order #{order.orderId}</span>
              <span>{order.tickets.length} ticket{order.tickets.length > 1 ? 's' : ''}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
