// ============================================================
// Event Detail Page — /events/[id]
//
// Shows the full details of a single event. This is what a
// customer sees after clicking on an EventCard.
//
// Displays:
//   - Event name, description, category
//   - Venue info (name, address, city, capacity)
//   - Organizer name
//   - Date/time range
//   - Sale window
//   - Section pricing table (if event is published)
//   - Status-dependent CTA button:
//     - "draft" → "Coming Soon" (disabled)
//     - "published" → "Buy Tickets" (links to seat map — future)
//     - "live" → "Buy Tickets" (links to seat map — future)
//     - "sold_out" → "Sold Out" (disabled)
//     - "closed" → "Event Ended" (disabled)
//
// API called: GET /api/events/:eventId
// ============================================================

'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

// ============================================================
// Helper: format a date into a readable string
// ============================================================
function formatDate(dateString) {
  if (!dateString) return '—';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-IN', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }) + ' at ' + date.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// ============================================================
// Helper: get badge class for event status
// ============================================================
function getStatusBadge(status) {
  const map = {
    draft: 'badge badge-draft',
    published: 'badge badge-published',
    live: 'badge badge-live',
    sold_out: 'badge badge-sold-out',
    closed: 'badge badge-closed',
  };
  return map[status] || 'badge badge-draft';
}

export default function EventDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const { loading: authLoading } = useAuth();

  // Build the back-link URL carrying the cityId the user was browsing,
  // so clicking "Back to Events" returns them to the same city filter.
  const cityId = searchParams.get('cityId');
  const backHref = cityId ? `/events?cityId=${cityId}` : '/events';

  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Live clock — ticks every second so the countdown and
  // canBuyTickets update in real time without a page refresh.
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const timerRef = useRef(null);

  // ----------------------------------------------------------
  // Fetch event details on mount
  // ----------------------------------------------------------
  useEffect(() => {
    if (authLoading) return;

    async function fetchEvent() {
      try {
        const data = await api.get(`/events/${params.id}`);
        setEvent(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    fetchEvent();
  }, [params.id, authLoading]);

  // ---- Determine if tickets are buyable ----
  // Computed here (before early returns) so the useEffect below
  // always runs in the same hook order.
  const saleStart = event?.sale_window_start ? new Date(event.sale_window_start) : null;
  const saleEnd = event?.sale_window_end ? new Date(event.sale_window_end) : null;
  const isPublishedOrLive = event?.status === 'published' || event?.status === 'live';
  const saleNotStarted = saleStart && currentTime < saleStart;
  const saleClosed = saleEnd && currentTime > saleEnd;
  const canBuyTickets = isPublishedOrLive && !saleNotStarted && !saleClosed;

  // Start the 1-second ticker when the sale hasn't started yet,
  // so the countdown updates live and the button auto-enables.
  useEffect(() => {
    if (!saleNotStarted) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    timerRef.current = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    return () => clearInterval(timerRef.current);
  }, [saleNotStarted]);

  // Helper: format seconds into "Xh Ym Zs"
  function formatCountdown(ms) {
    if (ms <= 0) return '0s';
    const totalSecs = Math.floor(ms / 1000);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // ---- Loading state ----
  if (loading) {
    return (
      <div className="page-container flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="spinner mx-auto mb-4" style={{ width: 40, height: 40 }}></div>
          <p style={{ color: 'var(--text-muted)' }}>Loading event details...</p>
        </div>
      </div>
    );
  }

  // ---- Error state ----
  if (error) {
    return (
      <div className="page-container flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="text-5xl mb-4">😕</div>
          <h2 className="text-xl font-semibold mb-2">Event not found</h2>
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>{error}</p>
          <Link href={backHref} className="btn-primary no-underline">
            Back to Events
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container py-8 animate-fade-in">

      {/* ---- Back link ---- */}
      <Link href={backHref} className="text-sm no-underline mb-6 inline-block"
            style={{ color: 'var(--text-secondary)' }}>
        ← Back to Events
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

        {/* ============================================================
            LEFT COLUMN — Event details (takes 2/3 of the grid)
            ============================================================ */}
        <div className="lg:col-span-2">
          <div className="card p-8">

            {/* Status + Category */}
            <div className="flex items-center gap-3 mb-4">
              <span className={getStatusBadge(event.status)}>
                {event.status === 'sold_out' ? 'Sold Out' : event.status}
              </span>
              {event.category && (
                <span className="text-xs font-medium px-2.5 py-1 rounded-full"
                      style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}>
                  {event.category}
                </span>
              )}
            </div>

            {/* Event Name */}
            <h1 className="text-3xl font-bold mb-4">{event.event_name}</h1>

            {/* Description */}
            {event.description && (
              <p className="text-base leading-relaxed mb-8"
                 style={{ color: 'var(--text-secondary)' }}>
                {event.description}
              </p>
            )}

            {/* Details grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">

              {/* Venue */}
              <div>
                <h3 className="text-xs font-semibold uppercase mb-1.5"
                    style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                  Venue
                </h3>
                <p className="font-medium">{event.venue_name}</p>
                {event.address && (
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {event.address}
                  </p>
                )}
                {event.city && (
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {event.city}
                  </p>
                )}
              </div>

              {/* Organizer */}
              <div>
                <h3 className="text-xs font-semibold uppercase mb-1.5"
                    style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                  Organized by
                </h3>
                <p className="font-medium">{event.org_name}</p>
              </div>

              {/* Start Time */}
              <div>
                <h3 className="text-xs font-semibold uppercase mb-1.5"
                    style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                  Starts
                </h3>
                <p className="font-medium">{formatDate(event.event_start_time)}</p>
              </div>

              {/* End Time */}
              <div>
                <h3 className="text-xs font-semibold uppercase mb-1.5"
                    style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                  Ends
                </h3>
                <p className="font-medium">{formatDate(event.event_end_time)}</p>
              </div>

              {/* Capacity */}
              {event.total_capacity && (
                <div>
                  <h3 className="text-xs font-semibold uppercase mb-1.5"
                      style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                    Venue Capacity
                  </h3>
                  <p className="font-medium">{event.total_capacity} seats</p>
                </div>
              )}

              {/* Sale Window */}
              {event.sale_window_start && (
                <div>
                  <h3 className="text-xs font-semibold uppercase mb-1.5"
                      style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                    Ticket Sales
                  </h3>
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {formatDate(event.sale_window_start)}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    to {formatDate(event.sale_window_end)}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ============================================================
            RIGHT COLUMN — Pricing & Buy button (takes 1/3)
            ============================================================ */}
        <div>
          <div className="card p-6 sticky top-24">

            {/* Section Pricing Table */}
            {event.sectionPricing && event.sectionPricing.length > 0 ? (
              <>
                <h3 className="text-sm font-semibold uppercase mb-4"
                    style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                  Ticket Prices
                </h3>
                <div className="flex flex-col gap-3 mb-6">
                  {event.sectionPricing.map((sp) => (
                    <div key={sp.section}
                         className="flex items-center justify-between p-3 rounded-lg"
                         style={{ background: 'var(--bg-secondary)' }}>
                      <span className="font-medium">{sp.section}</span>
                      <span className="font-bold gradient-text">
                        ₹{parseFloat(sp.price).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
                Pricing will be available when this event is published.
              </p>
            )}

            {/* CTA Button — sale window aware */}
            {canBuyTickets ? (
              <Link href={`/events/${event.event_id}/waiting-room`}
                    className="btn-primary w-full text-center no-underline block">
                🎫 Buy Tickets
              </Link>
            ) : isPublishedOrLive && saleNotStarted ? (
              <button className="btn-secondary w-full" disabled>
                🔒 Sales open {formatDate(event.sale_window_start)}
              </button>
            ) : isPublishedOrLive && saleClosed ? (
              <button className="btn-secondary w-full" disabled>
                Sales Closed
              </button>
            ) : event.status === 'sold_out' ? (
              <button className="btn-secondary w-full" disabled>
                Sold Out
              </button>
            ) : event.status === 'closed' ? (
              <button className="btn-secondary w-full" disabled>
                Event Ended
              </button>
            ) : (
              <button className="btn-secondary w-full" disabled>
                Coming Soon
              </button>
            )}

            {/* Live countdown when sale hasn't started */}
            {isPublishedOrLive && saleNotStarted && saleStart && (
              <div className="mt-3 p-3 rounded-xl text-center"
                style={{
                  background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  color: 'white',
                }}>
                <div className="text-xs mb-1">🕐 Tickets go live in</div>
                <div className="text-xl font-bold font-mono">
                  {formatCountdown(saleStart - currentTime)}
                </div>
              </div>
            )}

            <p className="text-xs text-center mt-3"
               style={{ color: 'var(--text-muted)' }}>
              {canBuyTickets
                ? 'Seats are held for 5 minutes during checkout'
                : saleNotStarted
                  ? `Sales window opens ${formatDate(event.sale_window_start)}`
                  : saleClosed
                    ? 'The sales window for this event has closed'
                    : 'Tickets are not available yet'}
            </p>
          </div>
        </div>

      </div>
    </div>
  );
}
