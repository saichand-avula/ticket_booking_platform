// ============================================================
// Organizer Dashboard — /organizer/dashboard
//
// The main page for organizers after logging in. Shows:
//   - ONLY events created by THIS organizer (privacy)
//   - Quick stats (total events, published count)
//   - Action buttons: create new event, manage each event
//
// API called: GET /api/events?myEvents=true
//   The backend reads myEvents=true and automatically filters
//   by the organizer's ID from their JWT token. This ensures
//   Organizer A can never see Organizer B's events.
// ============================================================

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

// ============================================================
// Helper: format date
// ============================================================
function formatDate(dateString) {
  if (!dateString) return '—';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-IN', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

// ============================================================
// Helper: status badge class
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

export default function OrganizerDashboard() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // ----------------------------------------------------------
  // Redirect non-organizers away from this page.
  // If someone types this URL directly without being an organizer,
  // they shouldn't see the dashboard.
  // ----------------------------------------------------------
  useEffect(() => {
    if (!authLoading && (!user || user.role !== 'organizer')) {
      router.push('/organizer/login');
    }
  }, [user, authLoading, router]);

  // ----------------------------------------------------------
  // Fetch all events once auth is ready.
  // ----------------------------------------------------------
  useEffect(() => {
    if (authLoading || !user || user.role !== 'organizer') return;

    async function fetchEvents() {
      try {
        // Fetch ONLY this organizer's events by passing ?myEvents=true.
        // The backend reads req.user.id from the JWT and filters by org_id.
        // This ensures Organizer A never sees Organizer B's events.
        const data = await api.get('/events?myEvents=true');
        setEvents(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    fetchEvents();
  }, [authLoading, user]);

  // Don't render anything while auth is loading or user is not organizer
  if (authLoading || !user || user.role !== 'organizer') {
    return null;
  }

  // Quick stats computed from the events array
  const totalEvents = events.length;
  const publishedCount = events.filter(e => e.status !== 'draft').length;
  const draftCount = events.filter(e => e.status === 'draft').length;

  return (
    <div className="page-container py-8 animate-fade-in">

      {/* ---- Header ---- */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-1">Organizer Dashboard</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Welcome back, {user.name}
          </p>
        </div>
        <Link href="/organizer/events/create" className="btn-primary no-underline">
          + Create Event
        </Link>
      </div>

      {/* ---- Quick Stats Cards ---- */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="card p-5" style={{ cursor: 'default' }}>
          <p className="text-xs uppercase font-semibold mb-1"
             style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
            Total Events
          </p>
          <p className="text-3xl font-bold">{totalEvents}</p>
        </div>
        <div className="card p-5" style={{ cursor: 'default' }}>
          <p className="text-xs uppercase font-semibold mb-1"
             style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
            Published
          </p>
          <p className="text-3xl font-bold" style={{ color: 'var(--color-success)' }}>
            {publishedCount}
          </p>
        </div>
        <div className="card p-5" style={{ cursor: 'default' }}>
          <p className="text-xs uppercase font-semibold mb-1"
             style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
            Drafts
          </p>
          <p className="text-3xl font-bold" style={{ color: 'var(--text-secondary)' }}>
            {draftCount}
          </p>
        </div>
      </div>

      {/* ---- Loading ---- */}
      {loading && (
        <div className="flex justify-center py-12">
          <div className="spinner" style={{ width: 40, height: 40 }}></div>
        </div>
      )}

      {/* ---- Error ---- */}
      {error && <div className="error-message">{error}</div>}

      {/* ---- Empty State ---- */}
      {!loading && !error && events.length === 0 && (
        <div className="text-center py-16">
          <div className="text-5xl mb-4">📋</div>
          <h3 className="text-xl font-semibold mb-2">No events yet</h3>
          <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
            Create your first event to get started.
          </p>
          <Link href="/organizer/events/create" className="btn-primary no-underline">
            Create Your First Event
          </Link>
        </div>
      )}

      {/* ---- Events Table ---- */}
      {!loading && !error && events.length > 0 && (
        <div className="card overflow-hidden" style={{ cursor: 'default' }}>
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <th className="text-left p-4 text-xs uppercase font-semibold"
                    style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                  Event
                </th>
                <th className="text-left p-4 text-xs uppercase font-semibold"
                    style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                  Venue
                </th>
                <th className="text-left p-4 text-xs uppercase font-semibold"
                    style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                  Date
                </th>
                <th className="text-left p-4 text-xs uppercase font-semibold"
                    style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                  Status
                </th>
                <th className="text-right p-4 text-xs uppercase font-semibold"
                    style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.event_id}
                    className="transition-colors"
                    style={{ borderBottom: '1px solid var(--border-color)' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-surface-hover)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                  <td className="p-4">
                    <p className="font-medium">{event.event_name}</p>
                    {event.category && (
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {event.category}
                      </p>
                    )}
                  </td>
                  <td className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {event.venue_name}
                  </td>
                  <td className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {formatDate(event.event_start_time)}
                  </td>
                  <td className="p-4">
                    <span className={getStatusBadge(event.status)}>
                      {event.status === 'sold_out' ? 'Sold Out' : event.status}
                    </span>
                  </td>
                  <td className="p-4 text-right">
                    <Link
                      href={`/organizer/events/${event.event_id}`}
                      className="btn-secondary text-xs py-1.5 px-3 no-underline"
                    >
                      Manage
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
