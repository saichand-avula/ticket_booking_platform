// ============================================================
// EventCard.js — Reusable event card component
//
// Displays a single event as a card in the event listing grid.
// Shows: event name, venue, city, date/time, category, status,
// and section pricing (if published).
//
// USAGE:
//   <EventCard event={eventObject} />
//
// The event object comes from GET /api/events and has this shape:
//   {
//     event_id, event_name, description, category,
//     event_start_time, event_end_time, status,
//     venue_name, city
//   }
// ============================================================

'use client';

import Link from 'next/link';

// ============================================================
// formatDate(dateString)
// ============================================================
// Converts an ISO date string like "2026-09-15T19:00:00"
// into a human-readable format like "Sep 15, 2026 · 7:00 PM".
// ============================================================
function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-IN', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }) + ' · ' + date.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// ============================================================
// getStatusBadge(status)
// ============================================================
// Returns the CSS class for the event's status badge.
// Maps event statuses to our badge color classes defined
// in globals.css.
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

export default function EventCard({ event, cityId }) {
  // Build the detail URL. If we know the city the user is browsing,
  // carry it as ?cityId so the detail page can put it in its
  // "Back to Events" link — returning the user to the right filter.
  const href = cityId && cityId !== 'all'
    ? `/events/${event.event_id}?cityId=${cityId}`
    : `/events/${event.event_id}`;

  return (
    <Link
      href={href}
      className="card p-5 block no-underline"
      style={{ color: 'inherit' }}
    >
      {/* ---- Top row: category + status badge ---- */}
      <div className="flex items-center justify-between mb-3">
        {event.category && (
          <span className="text-xs font-medium px-2.5 py-1 rounded-full"
            style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}>
            {event.category}
          </span>
        )}
        <span className={getStatusBadge(event.status)}>
          {event.status === 'sold_out' ? 'Sold Out' : event.status}
        </span>
      </div>

      {/* ---- Event name ---- */}
      <h3 className="text-lg font-semibold mb-2 leading-snug">
        {event.event_name}
      </h3>

      {/* ---- Venue + City ---- */}
      <div className="flex items-center gap-1.5 mb-1.5 text-sm"
        style={{ color: 'var(--text-secondary)' }}>
        <span>📍</span>
        {/* event.city_name comes from the backend's JOIN to the
            cities table (see eventService.getAllEvents) — the
            old event.city free-text field no longer exists. */}
        <span>{event.venue_name}{event.city_name ? `, ${event.city_name}` : ''}</span>
      </div>

      {/* ---- Date/Time ---- */}
      <div className="flex items-center gap-1.5 text-sm"
        style={{ color: 'var(--text-secondary)' }}>
        <span>📅</span>
        <span>{formatDate(event.event_start_time)}</span>
      </div>

      {/* ---- Description preview (truncated) ---- */}
      {event.description && (
        <p className="mt-3 text-sm line-clamp-2"
          style={{ color: 'var(--text-muted)' }}>
          {event.description}
        </p>
      )}
    </Link>
  );
}
