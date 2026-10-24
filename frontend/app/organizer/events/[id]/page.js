// ============================================================
// Manage Event Page — /organizer/events/[id]
//
// The command center for a single event. An organizer can:
//   1. VIEW event details + venue info
//   2. EDIT event details (name, description, sale window, etc.)
//   3. PUBLISH the event (if draft) with per-section pricing fields
//   4. UPDATE individual section prices (inline edit buttons)
//
// API calls:
//   GET   /api/events/:eventId          → load event details
//   PATCH /api/events/:eventId          → update event details
//   POST  /api/events/:eventId/publish  → publish + generate seats
//   PATCH /api/events/:eventId/pricing  → update section price
// ============================================================

'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

// Categories for the edit dropdown
const CATEGORIES = ['Music', 'Sports', 'Conference', 'Comedy', 'Theatre', 'Festival', 'Other'];

// ============================================================
// Helper: format date for display
// ============================================================
function formatDate(dateString) {
  if (!dateString) return '—';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-IN', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// ============================================================
// Helper: format date for datetime-local input value
// ============================================================
function toInputDate(dateString) {
  if (!dateString) return '';
  const d = new Date(dateString);
  // Format: YYYY-MM-DDTHH:MM (local time)
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ============================================================
// Helper: build the edit form "buffer" from event data
//
// This is called in three places — on initial load, when
// entering edit mode, and when cancelling edit mode — so the
// form always starts from a fresh snapshot of the saved event
// data rather than carrying over stale unsaved edits.
// ============================================================
function buildEditForm(data) {
  return {
    name: data.event_name || '',
    description: data.description || '',
    category: data.category || '',
    startTime: toInputDate(data.event_start_time),
    endTime: toInputDate(data.event_end_time),
    saleWindowStart: toInputDate(data.sale_window_start),
    saleWindowEnd: toInputDate(data.sale_window_end),
    bufferHoursBefore: data.buffer_hours_before ?? 2,
    bufferHoursAfter: data.buffer_hours_after ?? 2,
  };
}

// Status badge helper
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


export default function ManageEventPage() {
  const params = useParams();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  // Event data from the API
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // ----------------------------------------------------------
  // EDIT MODE STATE
  // When editing=true, event details become editable form fields.
  // ----------------------------------------------------------
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState('');

  // ----------------------------------------------------------
  // PUBLISH STATE — per-section pricing fields
  // sectionPrices is an object like { "VIP": "200", "General": "75" }
  // populated from the venue's seat_layout_json sections.
  // ----------------------------------------------------------
  const [sectionPrices, setSectionPrices] = useState({});
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState('');

  // ----------------------------------------------------------
  // INLINE PRICE EDIT STATE
  // editingSection tracks which section is being edited.
  // null = no inline edit active.
  // ----------------------------------------------------------
  const [editingSection, setEditingSection] = useState(null);
  const [editPrice, setEditPrice] = useState('');
  const [updatingPrice, setUpdatingPrice] = useState(false);
  const [priceResult, setPriceResult] = useState('');

  // Redirect non-organizers
  useEffect(() => {
    if (!authLoading && (!user || user.role !== 'organizer')) {
      router.push('/organizer/login');
    }
  }, [user, authLoading, router]);

  // ----------------------------------------------------------
  // Fetch event details
  // ----------------------------------------------------------
  async function loadEvent() {
    try {
      const data = await api.get(`/events/${params.id}`);
      setEvent(data);

      // Initialize section prices from venue layout (for publish form)
      if (data.seat_layout_json && data.seat_layout_json.sections) {
        const prices = {};
        data.seat_layout_json.sections.forEach((s) => {
          prices[s.name] = s.default_price?.toString() || '0';
        });
        setSectionPrices(prices);
      }

      // Initialize edit form buffer with current values
      setEditForm(buildEditForm(data));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (authLoading || !user) return;
    loadEvent();
  }, [params.id, authLoading, user]);

  // ----------------------------------------------------------
  // handleSaveEdit — saves the edited event details
  // ----------------------------------------------------------
  async function handleSaveEdit() {
    setSaving(true);
    setSaveResult('');
    setError('');

    // Client-side date validation
    if (editForm.startTime && editForm.endTime) {
      if (new Date(editForm.endTime) <= new Date(editForm.startTime)) {
        setError('End time must be after start time.');
        setSaving(false);
        return;
      }
    }
    if (editForm.saleWindowStart && editForm.saleWindowEnd) {
      if (new Date(editForm.saleWindowEnd) <= new Date(editForm.saleWindowStart)) {
        setError('Sale window end must be after sale window start.');
        setSaving(false);
        return;
      }
    }

    try {
      await api.patch(`/events/${params.id}`, editForm);
      setSaveResult('✅ Event updated successfully!');
      setEditing(false);
      // Reload event data to reflect changes
      await loadEvent();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // ----------------------------------------------------------
  // handlePublish — publishes the event and generates seats
  // ----------------------------------------------------------
  async function handlePublish() {
    setPublishing(true);
    setPublishResult('');
    setError('');

    // ----------------------------------------------------------
    // Validate: Sale window start is required before publishing.
    // The waiting room system needs to know when ticket sales open.
    // If the organizer hasn't set it yet, tell them to use the
    // Edit button above to add it first.
    // ----------------------------------------------------------
    if (!event.sale_window_start) {
      setError('⚠️ Sale Window Start is required before publishing. Click "Edit" above to set when ticket sales should open.');
      setPublishing(false);
      return;
    }

    try {
      // Build sectionPricing from the per-section input fields
      const pricingObj = {};
      for (const [section, price] of Object.entries(sectionPrices)) {
        if (price && parseFloat(price) > 0) {
          pricingObj[section] = parseFloat(price);
        }
      }

      const result = await api.post(`/events/${params.id}/publish`, {
        sectionPricing: Object.keys(pricingObj).length > 0 ? pricingObj : undefined,
      });

      setPublishResult(`✅ ${result.message} — ${result.seatsCreated} seats created!`);
      await loadEvent();
    } catch (err) {
      setError(err.message);
    } finally {
      setPublishing(false);
    }
  }

  // ----------------------------------------------------------
  // handleInlinePriceUpdate — updates a single section's price
  // ----------------------------------------------------------
  async function handleInlinePriceUpdate(section) {
    setUpdatingPrice(true);
    setPriceResult('');
    setError('');

    try {
      const result = await api.patch(`/events/${params.id}/pricing`, {
        section: section,
        price: parseFloat(editPrice),
      });

      setPriceResult(`✅ ${section} updated to ₹${result.newPrice}`);
      setEditingSection(null);
      setEditPrice('');
      await loadEvent();
    } catch (err) {
      setError(err.message);
    } finally {
      setUpdatingPrice(false);
    }
  }

  // ---- Guards ----
  if (authLoading || !user || user.role !== 'organizer') return null;

  if (loading) {
    return (
      <div className="page-container flex items-center justify-center min-h-[60vh]">
        <div className="spinner" style={{ width: 40, height: 40 }}></div>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="page-container text-center py-20">
        <p className="error-message inline-block">{error || 'Event not found'}</p>
      </div>
    );
  }

  const isDraft = event.status === 'draft';
  const isPublished = event.status !== 'draft';
  const sections = event.seat_layout_json?.sections || [];

  return (
    <div className="page-container py-8 animate-fade-in max-w-3xl">

      {/* ---- Back link ---- */}
      <Link href="/organizer/dashboard" className="text-sm no-underline mb-6 inline-block"
        style={{ color: 'var(--text-secondary)' }}>
        ← Back to Dashboard
      </Link>

      {/* ---- Header ---- */}
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-3xl font-bold">{event.event_name}</h1>
        <span className={getStatusBadge(event.status)}>
          {event.status === 'sold_out' ? 'Sold Out' : event.status}
        </span>
      </div>

      {/* Global messages */}
      {error && <div className="error-message mb-4">{error}</div>}
      {saveResult && <div className="success-message mb-4">{saveResult}</div>}

      {/* ============================================================
          SECTION 1: EVENT DETAILS (view / edit toggle)
          ============================================================ */}
      <div className="card p-6 mb-6" style={{ cursor: 'default' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold uppercase"
            style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
            Event Details
          </h2>
          {!editing ? (
            <button
              onClick={() => {
                // Reset the buffer from the current saved event data
                // every time edit mode is (re)entered, so stale
                // unsaved edits from a previous session never show up.
                setEditForm(buildEditForm(event));
                setEditing(true);
                setSaveResult('');
              }}
              className="text-xs font-medium px-3 py-1.5 rounded-lg"
              style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}
            >
              ✏️ Edit
            </button>
          ) : (
            <div className="flex gap-2">
              <button onClick={handleSaveEdit} disabled={saving}
                className="text-xs font-medium px-3 py-1.5 rounded-lg"
                style={{ background: 'var(--color-primary)', color: 'white' }}>
                {saving ? 'Saving...' : '💾 Save'}
              </button>
              <button
                onClick={() => {
                  // Discard unsaved changes: reset the buffer back to
                  // the last saved event data before leaving edit mode.
                  setEditForm(buildEditForm(event));
                  setEditing(false);
                }}
                className="text-xs font-medium px-3 py-1.5 rounded-lg"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                Cancel
              </button>
            </div>
          )}
        </div>

        {!editing ? (
          // ---- VIEW MODE ----
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Event Name:</span>{' '}
              <span className="font-medium">{event.event_name}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Category:</span>{' '}
              <span className="font-medium">{event.category || '—'}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Venue:</span>{' '}
              <span className="font-medium">{event.venue_name}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>City:</span>{' '}
              {/* event.city_name comes from the backend's JOIN to
                  the cities table — the old free-text event.city
                  field no longer exists (see migration 003). */}
              <span className="font-medium">{event.city_name || '—'}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Starts:</span>{' '}
              <span className="font-medium">{formatDate(event.event_start_time)}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Ends:</span>{' '}
              <span className="font-medium">{formatDate(event.event_end_time)}</span>
            </div>
            {event.total_capacity && (
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Capacity:</span>{' '}
                <span className="font-medium">{event.total_capacity} seats</span>
              </div>
            )}
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Sale Opens:</span>{' '}
              <span className="font-medium">{formatDate(event.sale_window_start)}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Sale Closes:</span>{' '}
              <span className="font-medium">{formatDate(event.sale_window_end)}</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Buffer Before:</span>{' '}
              <span className="font-medium">{event.buffer_hours_before ?? 2}h</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Buffer After:</span>{' '}
              <span className="font-medium">{event.buffer_hours_after ?? 2}h</span>
            </div>
            {event.description && (
              <div className="col-span-2">
                <span style={{ color: 'var(--text-muted)' }}>Description:</span>{' '}
                <span className="font-medium">{event.description}</span>
              </div>
            )}
          </div>
        ) : (
          // ---- EDIT MODE ----
          <div className="flex flex-col gap-4">
            <div>
              <label className="label">Event Name</label>
              <input type="text" className="input"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            </div>
            <div>
              <label className="label">Description</label>
              <textarea className="input" rows={3}
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                style={{ resize: 'vertical' }} />
            </div>
            <div>
              <label className="label">Category</label>
              <select className="input"
                value={editForm.category}
                onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}>
                <option value="">No category</option>
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Start Time</label>
                <input type="datetime-local" className="input"
                  value={editForm.startTime}
                  onChange={(e) => setEditForm({ ...editForm, startTime: e.target.value })} />
              </div>
              <div>
                <label className="label">End Time</label>
                <input type="datetime-local" className="input"
                  value={editForm.endTime}
                  min={editForm.startTime || undefined}
                  onChange={(e) => setEditForm({ ...editForm, endTime: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Sale Window Opens</label>
                <input type="datetime-local" className="input"
                  value={editForm.saleWindowStart}
                  onChange={(e) => setEditForm({ ...editForm, saleWindowStart: e.target.value })} />
              </div>
              <div>
                <label className="label">Sale Window Closes</label>
                <input type="datetime-local" className="input"
                  value={editForm.saleWindowEnd}
                  min={editForm.saleWindowStart || undefined}
                  onChange={(e) => setEditForm({ ...editForm, saleWindowEnd: e.target.value })} />
              </div>
            </div>
            {/* Buffer Hours */}
            <div className="p-4 rounded-lg"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
              <p className="text-sm font-medium mb-1">🔒 Venue Buffer Time</p>
              <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                Setup/teardown time that blocks the venue around the event.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label text-xs">Hours Before</label>
                  <input type="number" className="input text-sm py-2"
                    min="0" max="24" step="0.5"
                    value={editForm.bufferHoursBefore}
                    onChange={(e) => setEditForm({ ...editForm, bufferHoursBefore: parseFloat(e.target.value) || 0 })} />
                </div>
                <div>
                  <label className="label text-xs">Hours After</label>
                  <input type="number" className="input text-sm py-2"
                    min="0" max="24" step="0.5"
                    value={editForm.bufferHoursAfter}
                    onChange={(e) => setEditForm({ ...editForm, bufferHoursAfter: parseFloat(e.target.value) || 0 })} />
                </div>
              </div>
            </div>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Venue cannot be changed after creation. All other fields can be updated anytime.
            </p>
          </div>
        )}
      </div>


      {/* ============================================================
          SECTION 2: PUBLISH (draft only)
          Shows individual price input for EACH section from the
          venue's seat_layout_json.
          ============================================================ */}
      {isDraft && (
        <div className="card p-6 mb-6" style={{ cursor: 'default', borderColor: 'var(--color-primary)' }}>
          <h2 className="text-lg font-semibold mb-2">🚀 Publish This Event</h2>
          <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
            Publishing generates all seat rows and makes the event visible to customers.
            Set the ticket price for each section below.
          </p>

          {/* Per-section pricing fields */}
          {sections.length > 0 ? (
            <div className="flex flex-col gap-3 mb-5">
              {sections.map((section) => (
                <div key={section.name}
                  className="flex items-center gap-4 p-4 rounded-lg"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                  <div className="flex-1">
                    <p className="font-semibold text-sm">{section.name}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {section.rows?.length || 0} rows × {section.seats_per_row} seats
                      = {(section.rows?.length || 0) * section.seats_per_row} seats
                    </p>
                  </div>
                  <div className="w-32">
                    <label className="label text-xs">Price (₹)</label>
                    <input
                      type="number"
                      className="input text-sm py-2"
                      min="0"
                      step="0.01"
                      value={sectionPrices[section.name] || ''}
                      onChange={(e) => setSectionPrices({
                        ...sectionPrices,
                        [section.name]: e.target.value,
                      })}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>
              No section layout found. The venue may not have a seat layout configured.
            </p>
          )}

          {publishResult && <div className="success-message mb-4">{publishResult}</div>}

          <button onClick={handlePublish} className="btn-primary" disabled={publishing}>
            {publishing ? (
              <span className="flex items-center gap-2">
                <span className="spinner" style={{ width: 18, height: 18 }}></span>
                Publishing...
              </span>
            ) : (
              '🚀 Publish Event & Generate Seats'
            )}
          </button>
        </div>
      )}


      {/* ============================================================
          SECTION 3: CURRENT PRICING (published events)
          Shows each section with an inline "Edit" button beside it.
          Clicking Edit reveals an input to change the price.
          ============================================================ */}
      {isPublished && event.sectionPricing && event.sectionPricing.length > 0 && (
        <div className="card p-6 mb-6" style={{ cursor: 'default' }}>
          <h2 className="text-lg font-semibold mb-4">💰 Section Pricing</h2>

          {priceResult && <div className="success-message mb-4">{priceResult}</div>}

          <div className="flex flex-col gap-2">
            {event.sectionPricing.map((sp) => (
              <div key={sp.section}
                className="flex items-center justify-between p-4 rounded-lg"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>

                {/* Section name and current price */}
                <div className="flex items-center gap-4 flex-1">
                  <span className="font-semibold">{sp.section}</span>
                  {editingSection !== sp.section && (
                    <span className="font-bold gradient-text text-lg">
                      ₹{parseFloat(sp.price).toFixed(2)}
                    </span>
                  )}
                </div>

                {/* Inline edit or Edit button */}
                {editingSection === sp.section ? (
                  // ---- INLINE EDIT MODE for this section ----
                  <div className="flex items-center gap-2">
                    <span className="text-sm" style={{ color: 'var(--text-muted)' }}>₹</span>
                    <input
                      type="number"
                      className="input text-sm py-1.5 w-24"
                      min="0.01"
                      step="0.01"
                      value={editPrice}
                      onChange={(e) => setEditPrice(e.target.value)}
                      autoFocus
                    />
                    <button
                      onClick={() => handleInlinePriceUpdate(sp.section)}
                      disabled={updatingPrice || !editPrice}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg"
                      style={{ background: 'var(--color-primary)', color: 'white' }}
                    >
                      {updatingPrice ? '...' : 'Save'}
                    </button>
                    <button
                      onClick={() => { setEditingSection(null); setEditPrice(''); }}
                      className="text-xs font-medium px-2 py-1.5 rounded-lg"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  // ---- Edit button ----
                  <button
                    onClick={() => {
                      setEditingSection(sp.section);
                      setEditPrice(parseFloat(sp.price).toString());
                      setPriceResult('');
                    }}
                    className="text-xs font-medium px-3 py-1.5 rounded-lg"
                    style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}
                  >
                    ✏️ Edit Price
                  </button>
                )}
              </div>
            ))}
          </div>

          <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
            Price updates apply to unsold seats only. Already-sold tickets keep their original price.
          </p>
        </div>
      )}
    </div>
  );
}