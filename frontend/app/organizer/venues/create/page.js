// ============================================================
// Create Venue Page — /organizer/venues/create
//
// A dedicated page for organizers to create new venues with:
//   - Venue name, address, city (dropdown from /api/cities)
//   - Section builder (add/remove sections, set rows, seats, prices)
//
// Separated from "Create Event" so the two concerns don't mix.
// After creating a venue, the organizer is redirected back to
// the create event page where they can select it from the dropdown.
//
// API calls:
//   GET  /api/cities  → populate city dropdown
//   POST /api/venues  → create the venue
// ============================================================

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

export default function CreateVenuePage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  // Cities dropdown
  const [cities, setCities] = useState([]);

  // Venue form fields
  const [venueName, setVenueName] = useState('');
  const [venueAddress, setVenueAddress] = useState('');
  const [venueCityId, setVenueCityId] = useState('');
  const [venueSections, setVenueSections] = useState([
    { name: 'General', rows: 'A,B,C', seatsPerRow: 20, defaultPrice: 50 },
  ]);

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Redirect non-organizers
  useEffect(() => {
    if (!authLoading && (!user || user.role !== 'organizer')) {
      router.push('/organizer/login');
    }
  }, [user, authLoading, router]);

  // Fetch cities for dropdown
  useEffect(() => {
    if (authLoading || !user) return;

    async function fetchCities() {
      try {
        const data = await api.get('/cities');
        setCities(data);
      } catch (err) {
        console.error('Failed to load cities:', err);
      }
    }

    fetchCities();
  }, [authLoading, user]);

  // Add a new blank section
  function addSection() {
    setVenueSections([
      ...venueSections,
      { name: '', rows: '', seatsPerRow: 10, defaultPrice: 50 },
    ]);
  }

  // Remove a section by index
  function removeSection(index) {
    setVenueSections(venueSections.filter((_, i) => i !== index));
  }

  // Update a field in a section
  function updateSection(index, field, value) {
    const updated = [...venueSections];
    updated[index] = { ...updated[index], [field]: value };
    setVenueSections(updated);
  }

  // Handle form submission
  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Validate
      if (!venueName.trim()) {
        throw new Error('Venue name is required.');
      }
      if (!venueCityId) {
        throw new Error('Please select a city.');
      }
      if (venueSections.length === 0) {
        throw new Error('At least one section is required.');
      }

      // Build seat layout JSON
      const seatLayoutJson = {
        sections: venueSections.map((s) => ({
          name: s.name || 'Unnamed',
          rows: s.rows.split(',').map((r) => r.trim()).filter(Boolean),
          seats_per_row: parseInt(s.seatsPerRow) || 10,
          default_price: parseFloat(s.defaultPrice) || 0,
        })),
      };

      // Create the venue
      const venue = await api.post('/venues', {
        name: venueName.trim(),
        address: venueAddress || undefined,
        cityId: venueCityId,
        seatLayoutJson,
      });

      // Redirect to dashboard after venue creation
      router.push('/organizer/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Guards
  if (authLoading || !user || user.role !== 'organizer') return null;

  return (
    <div className="page-container py-8 animate-fade-in max-w-2xl">

      {/* Back link */}
      <Link href="/organizer/dashboard" className="text-sm no-underline mb-6 inline-block"
        style={{ color: 'var(--text-secondary)' }}>
        ← Back to Dashboard
      </Link>

      <h1 className="text-3xl font-bold mb-2">Create New Venue</h1>
      <p className="text-sm mb-8" style={{ color: 'var(--text-secondary)' }}>
        Set up a venue with its seating layout. You can then use it when creating events.
      </p>

      <form onSubmit={handleSubmit}>
        <div className="card p-6 mb-6" style={{ cursor: 'default' }}>
          <h2 className="text-sm font-semibold uppercase mb-4"
            style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
            Venue Information
          </h2>

          <div className="flex flex-col gap-4">
            {/* Venue Name */}
            <div>
              <label className="label">Venue Name *</label>
              <input type="text" className="input" required
                placeholder="e.g. Bangalore Indoor Stadium"
                value={venueName}
                onChange={(e) => setVenueName(e.target.value)} />
            </div>

            {/* Address + City */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Address <span style={{ color: 'var(--text-muted)' }}>(optional)</span></label>
                <input type="text" className="input" placeholder="Street address"
                  value={venueAddress} onChange={(e) => setVenueAddress(e.target.value)} />
              </div>
              <div>
                <label className="label">City *</label>
                <select className="input" value={venueCityId} required
                  onChange={(e) => setVenueCityId(e.target.value)}>
                  <option value="" disabled>Select a city</option>
                  {cities.map((c) => (
                    <option key={c.city_id} value={c.city_id}>
                      {c.city_name}{c.state ? `, ${c.state}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* ---- Sections Builder ---- */}
        <div className="card p-6 mb-6" style={{ cursor: 'default' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold uppercase"
              style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
              Seating Sections
            </h2>
            <button type="button" onClick={addSection}
              className="text-xs font-medium px-3 py-1.5 rounded-lg"
              style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}>
              + Add Section
            </button>
          </div>

          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
            Each section has rows (comma-separated labels like A,B,C), seats per row, and a default price.
          </p>

          {venueSections.map((section, i) => (
            <div key={i} className="p-4 rounded-lg mb-3"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium">Section {i + 1}</span>
                {venueSections.length > 1 && (
                  <button type="button" onClick={() => removeSection(i)}
                    className="text-xs px-2 py-1 rounded"
                    style={{ color: 'var(--color-accent)' }}>
                    ✕ Remove
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label text-xs">Section Name</label>
                  <input type="text" className="input text-sm py-2"
                    placeholder="VIP" value={section.name}
                    onChange={(e) => updateSection(i, 'name', e.target.value)} />
                </div>
                <div>
                  <label className="label text-xs">Rows (comma-separated)</label>
                  <input type="text" className="input text-sm py-2"
                    placeholder="A,B,C" value={section.rows}
                    onChange={(e) => updateSection(i, 'rows', e.target.value)} />
                </div>
                <div>
                  <label className="label text-xs">Seats per Row</label>
                  <input type="number" className="input text-sm py-2"
                    min="1" value={section.seatsPerRow}
                    onChange={(e) => updateSection(i, 'seatsPerRow', e.target.value)} />
                </div>
                <div>
                  <label className="label text-xs">Default Price (₹)</label>
                  <input type="number" className="input text-sm py-2"
                    min="0" step="0.01" value={section.defaultPrice}
                    onChange={(e) => updateSection(i, 'defaultPrice', e.target.value)} />
                </div>
              </div>
            </div>
          ))}

          {/* Capacity preview */}
          {venueSections.length > 0 && (
            <div className="text-xs mt-3 p-3 rounded-lg"
              style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}>
              📊 Total capacity: <strong>
                {venueSections.reduce((sum, s) => {
                  const rows = s.rows ? s.rows.split(',').filter(r => r.trim()).length : 0;
                  return sum + (rows * (parseInt(s.seatsPerRow) || 0));
                }, 0)} seats
              </strong> across {venueSections.length} section(s)
            </div>
          )}
        </div>

        {error && <div className="error-message mb-4">{error}</div>}

        <button type="submit" className="btn-primary w-full py-3.5" disabled={loading}>
          {loading ? 'Creating Venue...' : '🏟️ Create Venue'}
        </button>

        <p className="text-xs text-center mt-3" style={{ color: 'var(--text-muted)' }}>
          After creating the venue, you'll be redirected to the dashboard.
        </p>
      </form>
    </div>
  );
}
