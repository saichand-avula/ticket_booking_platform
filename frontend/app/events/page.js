// ============================================================
// Events Listing Page — /events
//
// Browsing page for customers showing all published events.
//
// CITY FILTER APPROACH — URL query params:
//   The selected city is stored in the URL as ?cityId=3
//   So /events?cityId=3 shows Delhi events.
//   When you click an event, the detail page's "Back to Events"
//   link carries ?cityId=3 back, so you land exactly where
//   you left off — no storage API needed.
//
//   On first visit (no ?cityId in URL), the logged-in customer's
//   signup city is applied automatically by replacing the URL.
//
// API: GET /api/events?status=published&cityId=X&category=Y
// ============================================================

'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';
import EventCard from '@/app/components/EventCard';

const CATEGORIES = ['All', 'Music', 'Sports', 'Conference', 'Comedy', 'Theatre', 'Festival'];

// Wrap in Suspense because useSearchParams() requires it in Next.js 16
export default function EventsPageWrapper() {
  return (
    <Suspense fallback={
      <div className="page-container py-8">
        <div className="flex items-center justify-center py-20">
          <div className="spinner" style={{ width: 40, height: 40 }}></div>
        </div>
      </div>
    }>
      <EventsPage />
    </Suspense>
  );
}

function EventsPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Read city from URL — this is the single source of truth.
  // 'all' means no city filter.
  const cityIdFromUrl = searchParams.get('cityId') || 'all';

  // Category stays in local state (not in URL — keeps URL clean)
  const [category, setCategory] = useState('All');

  // Data state
  const [events, setEvents] = useState([]);
  const [cities, setCities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Tracks whether we've already applied the user's default city
  // to the URL on this mount (so we don't loop).
  const didApplyDefaultCity = useRef(false);

  // ----------------------------------------------------------
  // Fetch city dropdown options once on mount.
  // ----------------------------------------------------------
  useEffect(() => {
    async function fetchCities() {
      try {
        const data = await api.get('/cities');
        setCities(data);
      } catch {
        // Non-fatal — filters still work without this
      }
    }
    fetchCities();
  }, []);

  // ----------------------------------------------------------
  // Apply logged-in customer's default city to the URL,
  // but ONLY if there is no ?cityId already in the URL.
  // This way: first visit → default city; returning visit
  // from an event page → URL already has ?cityId → skip.
  // ----------------------------------------------------------
  useEffect(() => {
    if (authLoading) return;
    if (didApplyDefaultCity.current) return;
    didApplyDefaultCity.current = true;

    // Only redirect if the URL has no cityId yet AND the user
    // has a default city set (from signup).
    if (cityIdFromUrl === 'all' && user?.defaultCityId) {
      const params = new URLSearchParams(searchParams.toString());
      params.set('cityId', String(user.defaultCityId));
      router.replace(`/events?${params.toString()}`);
    }
  }, [authLoading, user]);

  // ----------------------------------------------------------
  // Fetch events whenever URL cityId or category changes.
  // Race condition guarded with an `ignore` flag.
  // ----------------------------------------------------------
  useEffect(() => {
    if (authLoading) return;

    let ignore = false;

    async function fetchEvents() {
      setLoading(true);
      setError('');

      try {
        const params = new URLSearchParams();
        params.set('status', 'published');
        if (category !== 'All') params.set('category', category);
        if (cityIdFromUrl && cityIdFromUrl !== 'all') params.set('cityId', cityIdFromUrl);

        const data = await api.get(`/events?${params.toString()}`);
        if (ignore) return;
        setEvents(data);
      } catch (err) {
        if (ignore) return;
        setError(err.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    fetchEvents();
    return () => { ignore = true; };
  }, [category, cityIdFromUrl, authLoading]);

  // ----------------------------------------------------------
  // When user picks a city from the dropdown, update the URL.
  // The URL change automatically re-triggers the fetch effect.
  // ----------------------------------------------------------
  function handleCityChange(val) {
    const params = new URLSearchParams(searchParams.toString());
    if (val === 'all') {
      params.delete('cityId');
    } else {
      params.set('cityId', val);
    }
    router.replace(`/events?${params.toString()}`);
  }

  return (
    <div className="page-container py-8 animate-fade-in">

      {/* ---- Page Header ---- */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Upcoming Events</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Find and book tickets for live events near you
        </p>
      </div>

      {/* ---- Filters Bar ---- */}
      <div className="flex flex-col sm:flex-row gap-4 mb-8">

        {/* Category filter buttons */}
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className="px-4 py-2 rounded-full text-sm font-medium transition-all"
              style={{
                background: category === cat ? 'var(--color-primary)' : 'var(--bg-surface)',
                color: category === cat ? 'white' : 'var(--text-secondary)',
                border: `1px solid ${category === cat ? 'var(--color-primary)' : 'var(--border-color)'}`,
              }}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* City dropdown — value mirrors the URL param */}
        <select
          className="input max-w-xs"
          value={cityIdFromUrl}
          onChange={(e) => handleCityChange(e.target.value)}
        >
          <option value="all">All Cities</option>
          {cities.map((c) => (
            <option key={c.city_id} value={c.city_id}>
              {c.city_name}
            </option>
          ))}
        </select>
      </div>

      {/* ---- Loading State ---- */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <div className="spinner mx-auto mb-4" style={{ width: 40, height: 40 }}></div>
            <p style={{ color: 'var(--text-muted)' }}>Loading events...</p>
          </div>
        </div>
      )}

      {/* ---- Error State ---- */}
      {error && !loading && (
        <div className="error-message max-w-md mx-auto text-center">{error}</div>
      )}

      {/* ---- Empty State ---- */}
      {!loading && !error && events.length === 0 && (
        <div className="text-center py-20">
          <div className="text-5xl mb-4">🎪</div>
          <h3 className="text-xl font-semibold mb-2">No events found</h3>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {category !== 'All' || cityIdFromUrl !== 'all'
              ? 'Try adjusting your filters.'
              : 'No published events yet. Check back soon!'}
          </p>
        </div>
      )}

      {/* ---- Events Grid ---- */}
      {!loading && !error && events.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {events.map((event) => (
            <EventCard key={event.event_id} event={event} cityId={cityIdFromUrl} />
          ))}
        </div>
      )}
    </div>
  );
}