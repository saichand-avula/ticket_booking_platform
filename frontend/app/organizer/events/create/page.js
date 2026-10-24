// ============================================================
// Create Event Page — /organizer/events/create
//
// A focused form for organizers to create a new event:
//   1. Select an existing venue from a dropdown
//   2. Fill in event details (name, dates, category, buffer time)
//   3. Submit → creates event as draft → redirect to manage page
//
// Venue creation is now on a separate page:
//   /organizer/venues/create
//
// API calls:
//   GET  /api/venues  → populate venue dropdown
//   POST /api/events  → create the event as draft
// ============================================================

'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

// Pre-defined categories for the dropdown
const CATEGORIES = ['Music', 'Sports', 'Conference', 'Comedy', 'Theatre', 'Festival', 'Other'];

// Wrap in Suspense because useSearchParams requires it in Next.js 16
export default function CreateEventPageWrapper() {
  return (
    <Suspense fallback={<div className="page-container py-8">Loading...</div>}>
      <CreateEventPage />
    </Suspense>
  );
}

function CreateEventPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Venue selection
  const [venues, setVenues] = useState([]);
  const [selectedVenueId, setSelectedVenueId] = useState('');
  const [venuesLoading, setVenuesLoading] = useState(true);

  // Event form fields
  const [eventName, setEventName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [saleWindowStart, setSaleWindowStart] = useState('');
  const [saleWindowEnd, setSaleWindowEnd] = useState('');

  // Buffer hours for venue conflict check
  const [bufferHoursBefore, setBufferHoursBefore] = useState(2);
  const [bufferHoursAfter, setBufferHoursAfter] = useState(2);

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Redirect non-organizers
  useEffect(() => {
    if (!authLoading && (!user || user.role !== 'organizer')) {
      router.push('/organizer/login');
    }
  }, [user, authLoading, router]);

  // Fetch existing venues for the dropdown
  useEffect(() => {
    if (authLoading || !user) return;

    async function fetchVenues() {
      try {
        const data = await api.get('/venues');
        setVenues(data);
      } catch (err) {
        console.error('Failed to load venues:', err);
      } finally {
        setVenuesLoading(false);
      }
    }

    fetchVenues();
  }, [authLoading, user]);

  // Auto-select newly created venue if redirected from venue creation
  useEffect(() => {
    const newVenueId = searchParams.get('newVenueId');
    if (newVenueId && venues.length > 0) {
      setSelectedVenueId(newVenueId);
    }
  }, [searchParams, venues]);

  // Handle event creation
  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    // Client-side validation
    if (!selectedVenueId) {
      setError('Please select a venue.');
      return;
    }
    if (!eventName.trim()) {
      setError('Event name is required.');
      return;
    }
    if (!startTime || !endTime) {
      setError('Start time and end time are required.');
      return;
    }
    if (new Date(endTime) <= new Date(startTime)) {
      setError('End time must be after start time.');
      return;
    }
    if (saleWindowStart && saleWindowEnd && new Date(saleWindowEnd) <= new Date(saleWindowStart)) {
      setError('Sale window end must be after sale window start.');
      return;
    }

    setLoading(true);

    try {
      const event = await api.post('/events', {
        venueId: parseInt(selectedVenueId),
        name: eventName.trim(),
        description: description || undefined,
        category: category || undefined,
        startTime,
        endTime,
        saleWindowStart: saleWindowStart || undefined,
        saleWindowEnd: saleWindowEnd || undefined,
        bufferHoursBefore,
        bufferHoursAfter,
      });

      router.push(`/organizer/events/${event.event_id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Guards
  if (authLoading || !user || user.role !== 'organizer') return null;

  // Find selected venue to show preview
  const selectedVenue = venues.find(v => String(v.venue_id) === String(selectedVenueId));

  return (
    <div className="page-container py-8 animate-fade-in max-w-2xl">

      {/* Back link */}
      <Link href="/organizer/dashboard" className="text-sm no-underline mb-6 inline-block"
        style={{ color: 'var(--text-secondary)' }}>
        ← Back to Dashboard
      </Link>

      <h1 className="text-3xl font-bold mb-2">Create New Event</h1>
      <p className="text-sm mb-8" style={{ color: 'var(--text-secondary)' }}>
        Select a venue and fill in the event details. The event will be saved as a draft.
      </p>

      <form onSubmit={handleSubmit}>

        {/* ============================================================
            VENUE SELECTION
            ============================================================ */}
        <div className="card p-6 mb-6" style={{ cursor: 'default' }}>
          <h2 className="text-sm font-semibold uppercase mb-4"
            style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
            🏟️ Select Venue
          </h2>

          {venuesLoading ? (
            <div className="flex items-center gap-2">
              <div className="spinner" style={{ width: 18, height: 18 }}></div>
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading venues...</span>
            </div>
          ) : venues.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
                No venues available. Create a venue first.
              </p>
              <Link href="/organizer/venues/create" className="btn-primary no-underline text-sm">
                + Create Venue
              </Link>
            </div>
          ) : (
            <>
              <select className="input" value={selectedVenueId}
                onChange={(e) => setSelectedVenueId(e.target.value)} required>
                <option value="" disabled>Choose a venue...</option>
                {venues.map((v) => (
                  <option key={v.venue_id} value={v.venue_id}>
                    {v.venue_name} — {v.city_name || 'No city'} ({v.total_capacity || '?'} seats)
                  </option>
                ))}
              </select>

              {/* Venue preview when selected */}
              {selectedVenue && (
                <div className="mt-3 p-3 rounded-lg text-xs"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                  <strong>{selectedVenue.venue_name}</strong>
                  {selectedVenue.city_name && <span> · {selectedVenue.city_name}</span>}
                  {selectedVenue.total_capacity && <span> · {selectedVenue.total_capacity} seats</span>}
                  {selectedVenue.seat_layout_json?.sections && (
                    <span> · Sections: {selectedVenue.seat_layout_json.sections.map(s => s.name).join(', ')}</span>
                  )}
                </div>
              )}

              <div className="mt-3">
                <Link href="/organizer/venues/create"
                  className="text-xs no-underline"
                  style={{ color: 'var(--color-primary)' }}>
                  + Create a new venue instead
                </Link>
              </div>
            </>
          )}
        </div>


        {/* ============================================================
            EVENT DETAILS
            ============================================================ */}
        <div className="card p-6 mb-6" style={{ cursor: 'default' }}>
          <h2 className="text-sm font-semibold uppercase mb-4"
            style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
            📝 Event Details
          </h2>

          <div className="flex flex-col gap-4">
            {/* Event Name */}
            <div>
              <label className="label">Event Name *</label>
              <input type="text" className="input" required
                placeholder="e.g. Rock Concert 2026"
                value={eventName}
                onChange={(e) => setEventName(e.target.value)} />
            </div>

            {/* Description */}
            <div>
              <label className="label">Description <span style={{ color: 'var(--text-muted)' }}>(optional)</span></label>
              <textarea className="input" rows={3} style={{ resize: 'vertical' }}
                placeholder="Describe the event..."
                value={description}
                onChange={(e) => setDescription(e.target.value)} />
            </div>

            {/* Category */}
            <div>
              <label className="label">Category <span style={{ color: 'var(--text-muted)' }}>(optional)</span></label>
              <select className="input" value={category}
                onChange={(e) => setCategory(e.target.value)}>
                <option value="">Select category...</option>
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>

            {/* Start + End Time */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Start Time *</label>
                <input type="datetime-local" className="input" required
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)} />
              </div>
              <div>
                <label className="label">End Time *</label>
                <input type="datetime-local" className="input" required
                  value={endTime}
                  min={startTime || undefined}
                  onChange={(e) => setEndTime(e.target.value)} />
              </div>
            </div>
          </div>
        </div>


        {/* ============================================================
            SALE WINDOW + BUFFER TIME
            ============================================================ */}
        <div className="card p-6 mb-6" style={{ cursor: 'default' }}>
          <h2 className="text-sm font-semibold uppercase mb-2"
            style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
            ⏰ Sale Window & Buffer Time
          </h2>
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
            Optional now — you can set these later from the manage page before publishing.
          </p>

          <div className="flex flex-col gap-4">
            {/* Sale Window */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Sales Open</label>
                <input type="datetime-local" className="input"
                  value={saleWindowStart}
                  onChange={(e) => setSaleWindowStart(e.target.value)} />
              </div>
              <div>
                <label className="label">Sales Close</label>
                <input type="datetime-local" className="input"
                  value={saleWindowEnd}
                  onChange={(e) => setSaleWindowEnd(e.target.value)} />
              </div>
            </div>

            {/* Buffer Hours */}
            <div className="p-4 rounded-lg"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
              <p className="text-sm font-medium mb-1">🔒 Venue Buffer Time</p>
              <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                How long before and after the event the venue should be blocked
                (for setup, teardown, cleaning, etc.)
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label text-xs">Hours Before Event</label>
                  <input type="number" className="input text-sm py-2"
                    min="0" max="24" step="0.5"
                    value={bufferHoursBefore}
                    onChange={(e) => setBufferHoursBefore(parseFloat(e.target.value) || 0)} />
                </div>
                <div>
                  <label className="label text-xs">Hours After Event</label>
                  <input type="number" className="input text-sm py-2"
                    min="0" max="24" step="0.5"
                    value={bufferHoursAfter}
                    onChange={(e) => setBufferHoursAfter(parseFloat(e.target.value) || 0)} />
                </div>
              </div>
            </div>
          </div>
        </div>


        {/* ---- Error + Submit ---- */}
        {error && <div className="error-message mb-4">{error}</div>}

        <button type="submit" className="btn-primary w-full py-3.5" disabled={loading || !selectedVenueId}>
          {loading ? 'Creating Event...' : '📝 Create Event as Draft'}
        </button>

        <p className="text-xs text-center mt-3" style={{ color: 'var(--text-muted)' }}>
          The event will be created as a draft. You can set pricing and publish it on the next page.
        </p>
      </form>
    </div>
  );
}
