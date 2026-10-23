// ============================================================
// Confirmation Page — /confirmation/[orderId]
//
// Shows "Booking Confirmed!" with ticket details and QR codes
// after successful payment.
//
// API: GET /api/orders/:orderId
// ============================================================

'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

export default function ConfirmationPage() {
  const params = useParams();
  const { user, loading: authLoading } = useAuth();
  const orderId = params.orderId;

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (authLoading) return;

    async function fetchOrder() {
      try {
        const data = await api.get(`/orders/${orderId}`);
        setOrder(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    fetchOrder();
  }, [orderId, authLoading]);

  if (loading) {
    return (
      <div className="page-container py-20 text-center">
        <div className="spinner mx-auto mb-4" style={{ width: 40, height: 40 }}></div>
        <p style={{ color: 'var(--text-muted)' }}>Loading confirmation...</p>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="page-container py-20 text-center">
        <div className="text-5xl mb-4">😕</div>
        <h2 className="text-xl font-semibold mb-2">Order not found</h2>
        <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>{error}</p>
        <Link href="/events" className="btn-primary no-underline">Browse Events</Link>
      </div>
    );
  }

  return (
    <div className="page-container py-8 animate-fade-in max-w-2xl mx-auto">

      {/* ---- Success Header ---- */}
      <div className="text-center mb-8">
        <div className="text-6xl mb-4">🎉</div>
        <h1 className="text-3xl font-bold mb-2">Booking Confirmed!</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Order #{order.orderId} · {order.tickets?.length || 0} ticket{(order.tickets?.length || 0) > 1 ? 's' : ''}
        </p>
      </div>

      {/* ---- Event Card ---- */}
      <div className="card p-5 mb-6">
        <h2 className="text-xl font-bold mb-2">{order.eventName}</h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          📍 {order.venueName}
        </p>
        <div className="mt-3 flex items-center justify-between">
          <span className="badge badge-published">Confirmed</span>
          <span className="text-lg font-bold" style={{ color: 'var(--color-primary)' }}>
            ₹{order.totalAmount.toLocaleString()}
          </span>
        </div>
      </div>

      {/* ---- Tickets with QR Codes ---- */}
      <h3 className="text-sm font-bold mb-3" style={{ color: 'var(--text-muted)' }}>
        YOUR TICKETS
      </h3>

      <div className="flex flex-col gap-4 mb-8">
        {order.tickets?.map((ticket, index) => (
          <div key={ticket.ticketId} className="card p-5">
            <div className="flex flex-col sm:flex-row gap-4">
              {/* Ticket Info */}
              <div className="flex-1">
                <div className="text-xs font-bold mb-2" style={{ color: 'var(--text-muted)' }}>
                  TICKET #{index + 1}
                </div>
                <div className="text-lg font-bold mb-1">
                  {ticket.section}
                </div>
                <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Row {ticket.row} · Seat {ticket.seatNumber}
                </div>
                <div className="text-sm font-bold mt-2">
                  ₹{ticket.price.toLocaleString()}
                </div>
              </div>

              {/* QR Code */}
              {ticket.qrCode && (
                <div className="flex-shrink-0 text-center">
                  <img
                    src={ticket.qrCode}
                    alt={`QR Code - Ticket #${index + 1}`}
                    className="rounded-lg mx-auto"
                    style={{ width: 140, height: 140 }}
                  />
                  <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    Scan at entry
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ---- Action Buttons ---- */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Link href="/my-tickets" className="btn-primary text-center no-underline flex-1 py-3">
          🎫 View My Tickets
        </Link>
        <Link href="/events" className="btn-secondary text-center no-underline flex-1 py-3"
          style={{
            background: 'var(--bg-surface)',
            border: '2px solid var(--border-color)',
            borderRadius: '0.75rem',
            color: 'var(--text-primary)',
          }}>
          🎪 Browse More Events
        </Link>
      </div>
    </div>
  );
}
