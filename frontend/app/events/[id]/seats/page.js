// ============================================================
// Seat Selection Page — /events/[id]/seats
//
// Architecture-compliant seat map with:
//   - 10-minute selection timer (server-enforced via session TTL)
//   - Per-seat Redis acquisition (click → backend → Lua atomic)
//   - Optimistic UI with rollback on failure
//   - Section-first layout (tap section → see seats)
//   - holdId-based display (your seats = blue, others = grey)
//
// FLOW:
//   1. On mount: create booking session → get sessionId + holdId
//   2. Load seat map: GET /events/:id/seats?holdId=H123
//   3. Click seat: POST /booking-sessions/:sid/seats/:seatId
//   4. Click again: DELETE /booking-sessions/:sid/seats/:seatId
//   5. Proceed: POST /booking-sessions/:sid/proceed
//      → stores checkout data in sessionStorage → redirect to /checkout
//
// Timer: frontend displays countdown (10 min).
// Server enforces via session TTL + Redis seat TTL.
// On expiry: redirect to event page.
// ============================================================

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

export default function SeatSelectionPage() {
  const params = useParams();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const eventId = params.id;

  // --- State ---
  const [session, setSession] = useState(null);    // { sessionId, holdId, ttl }
  const [seats, setSeats] = useState([]);           // all seats with state
  const [sections, setSections] = useState([]);     // unique section names
  const [activeSection, setActiveSection] = useState(null);
  const [selectedSeats, setSelectedSeats] = useState([]); // seat IDs selected by user
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [seatError, setSeatError] = useState('');   // per-seat acquisition error
  const [timeLeft, setTimeLeft] = useState(600);    // 10 minutes
  const [proceeding, setProceeding] = useState(false);
  const timerRef = useRef(null);
  const wsRef = useRef(null);
  const sessionRef = useRef(null); // always-current session for async callbacks
  const expiredRef = useRef(false); // prevent double cleanup

  // ----------------------------------------------------------
  // WebSocket — real-time seat updates from other users
  // ----------------------------------------------------------
  useEffect(() => {
    if (!session || !eventId) return;

    const wsBase = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8002';
    const wsUrl = `${wsBase}/ws?eventId=${eventId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'SEAT_HELD') {
          const heldIds = msg.seatIds || [msg.seatId];
          // Another user held a seat — mark as unavailable (unless it's ours)
          setSeats(prev => prev.map(s =>
            heldIds.includes(s.seat_id) && s.state === 'AVAILABLE'
              ? { ...s, state: 'HELD_BY_OTHER' }
              : s
          ));
        } else if (msg.type === 'SEAT_AVAILABLE') {
          const availIds = msg.seatIds || [msg.seatId];
          // A seat was released — mark as available (any non-BOOKED state)
          setSeats(prev => prev.map(s =>
            availIds.includes(s.seat_id) && s.state !== 'BOOKED' && s.state !== 'AVAILABLE'
              ? { ...s, state: 'AVAILABLE' }
              : s
          ));
          // Also remove from our selected list if they were ours
          setSelectedSeats(prev => prev.filter(id => !availIds.includes(id)));
        } else if (msg.type === 'SEAT_BOOKED') {
          // Seats permanently booked
          const bookedIds = msg.seatIds || [msg.seatId];
          setSeats(prev => prev.map(s =>
            bookedIds.includes(s.seat_id) ? { ...s, state: 'BOOKED' } : s
          ));
        }
      } catch {}
    };

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [session, eventId]);

  // ----------------------------------------------------------
  // 1. Reuse existing session or create new one
  // ----------------------------------------------------------
  // When the user navigates BACK from checkout, their session
  // (and held seats) are still valid in Redis. We save the
  // sessionId/holdId in sessionStorage so we can resume.
  // ----------------------------------------------------------
  useEffect(() => {
    if (authLoading) return;

    async function initSession() {
      try {
        // Check sessionStorage for an existing session for this event
        const savedRaw = sessionStorage.getItem(`booking_session_${eventId}`);

        if (savedRaw) {
          const saved = JSON.parse(savedRaw);

          // Validate the session is still alive on the backend
          try {
            const existing = await api.get(`/booking-sessions/${saved.sessionId}`);

            if (existing && existing.ttlRemaining > 0) {
              // Session still valid — reuse it
              const resumedSession = {
                sessionId: existing.sessionId || saved.sessionId,
                holdId: existing.holdId,
                ttl: existing.ttlRemaining,
              };
              setSession(resumedSession);
              sessionRef.current = resumedSession;
              setTimeLeft(existing.ttlRemaining);
              await loadSeatMap(existing.holdId);
              return; // done — no need to create new session
            }
          } catch {
            // Session expired or invalid — clear and create new
            sessionStorage.removeItem(`booking_session_${eventId}`);
          }
        }

        // No valid session — create a new one
        const sess = await api.post(`/events/${eventId}/booking-sessions`);
        setSession(sess);
        sessionRef.current = sess;
        setTimeLeft(sess.ttl || 600);

        // Save to sessionStorage for back-navigation
        sessionStorage.setItem(`booking_session_${eventId}`, JSON.stringify({
          sessionId: sess.sessionId,
          holdId: sess.holdId,
        }));

        // Load seat map with holdId
        await loadSeatMap(sess.holdId);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    initSession();

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [authLoading, eventId]);

  // ----------------------------------------------------------
  // 2. Countdown timer (10 min selection)
  // ----------------------------------------------------------
  useEffect(() => {
    if (!session) return;

    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timerRef.current);
  }, [session]);

  // ----------------------------------------------------------
  // 2b. Handle session expiry (fires once when timeLeft hits 0)
  // ----------------------------------------------------------
  useEffect(() => {
    if (timeLeft !== 0 || !sessionRef.current || expiredRef.current) return;
    expiredRef.current = true;

    const sess = sessionRef.current;

    // Tell backend to release seats + broadcast via WebSocket
    // Pass holdId/eventId/seatIds in body as fallback since
    // the Redis session key has the same 600s TTL and has likely
    // already expired by now.
    api.delete(`/booking-sessions/${sess.sessionId}`, {
      holdId: sess.holdId,
      eventId: eventId,
      seatIds: selectedSeats,
    }).catch(() => {});

    // Clean up frontend state
    sessionStorage.removeItem(`booking_session_${eventId}`);
    router.push(`/events/${eventId}`);
  }, [timeLeft, eventId, router]);

  // ----------------------------------------------------------
  // Load seat map from backend
  // ----------------------------------------------------------
  async function loadSeatMap(holdId) {
    const data = await api.get(`/events/${eventId}/seats?holdId=${holdId}`);
    const seatList = data.seats || [];
    setSeats(seatList);

    // Extract unique sections
    const uniqueSections = [...new Set(seatList.map(s => s.section))];
    setSections(uniqueSections);
    if (uniqueSections.length > 0 && !activeSection) {
      setActiveSection(uniqueSections[0]);
    }

    // Track already-selected seats (HELD_BY_YOU)
    const mySeats = seatList
      .filter(s => s.state === 'HELD_BY_YOU')
      .map(s => s.seat_id);
    setSelectedSeats(mySeats);
  }

  // ----------------------------------------------------------
  // 3. Click seat — select or deselect
  // ----------------------------------------------------------
  const handleSeatClick = useCallback(async (seat) => {
    if (!session) return;
    setSeatError('');

    const isSelected = selectedSeats.includes(seat.seat_id);

    if (isSelected) {
      // --- DESELECT ---
      try {
        await api.delete(`/booking-sessions/${session.sessionId}/seats/${seat.seat_id}`);
        setSelectedSeats(prev => prev.filter(id => id !== seat.seat_id));
        // Update seat state locally
        setSeats(prev => prev.map(s =>
          s.seat_id === seat.seat_id ? { ...s, state: 'AVAILABLE' } : s
        ));
      } catch (err) {
        setSeatError(err.message);
      }
    } else {
      // --- SELECT ---
      if (selectedSeats.length >= 10) {
        setSeatError('Maximum 10 seats per booking');
        return;
      }

      // Optimistic UI — show blue immediately
      setSeats(prev => prev.map(s =>
        s.seat_id === seat.seat_id ? { ...s, state: 'HELD_BY_YOU' } : s
      ));
      setSelectedSeats(prev => [...prev, seat.seat_id]);

      try {
        await api.post(`/booking-sessions/${session.sessionId}/seats/${seat.seat_id}`);
      } catch (err) {
        // Rollback optimistic UI
        setSeats(prev => prev.map(s =>
          s.seat_id === seat.seat_id ? { ...s, state: 'HELD_BY_OTHER' } : s
        ));
        setSelectedSeats(prev => prev.filter(id => id !== seat.seat_id));
        setSeatError(err.message || 'Seat unavailable');
      }
    }
  }, [session, selectedSeats]);

  // ----------------------------------------------------------
  // 4. Proceed to payment
  // ----------------------------------------------------------
  async function handleProceed() {
    if (!session || selectedSeats.length === 0) return;
    setProceeding(true);
    setError('');

    try {
      const result = await api.post(`/booking-sessions/${session.sessionId}/proceed`);

      // Store checkout data for the checkout page
      sessionStorage.setItem('checkout_data', JSON.stringify({
        sessionId: result.sessionId,
        holdId: result.holdId,
        eventId: result.eventId,
        eventName: result.eventName,
        venueName: result.venueName,
        seats: result.seats,
        totalAmount: result.totalAmount,
        paymentTtl: result.paymentTtl,
        paymentExpiresAt: result.paymentExpiresAt,
      }));

      router.push('/checkout');
    } catch (err) {
      setError(err.message);
      setProceeding(false);
    }
  }

  // ----------------------------------------------------------
  // 5. Back to Event — clean up session completely
  // ----------------------------------------------------------
  async function handleBackToEvent() {
    // Release all held seats on backend + broadcast via WebSocket
    if (session?.sessionId) {
      try {
        await api.delete(`/booking-sessions/${session.sessionId}`, {
          holdId: session.holdId,
          eventId: eventId,
          seatIds: selectedSeats,
        });
      } catch {}
    }
    sessionStorage.removeItem(`booking_session_${eventId}`);
    router.push(`/events/${eventId}`);
  }

  // ----------------------------------------------------------
  // Format time as M:SS
  // ----------------------------------------------------------
  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ----------------------------------------------------------
  // Get seat color/style based on state
  // ----------------------------------------------------------
  function getSeatStyle(seat) {
    switch (seat.state) {
      case 'AVAILABLE':
        return {
          background: 'var(--bg-primary)',
          border: '2px solid var(--border-primary)',
          cursor: 'pointer',
          color: 'var(--text-primary)',
        };
      case 'HELD_BY_YOU':
        return {
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          border: '2px solid #6366f1',
          cursor: 'pointer',
          color: 'white',
        };
      case 'HELD_BY_OTHER':
      case 'BOOKED':
        return {
          background: 'var(--bg-secondary)',
          border: '2px solid transparent',
          cursor: 'not-allowed',
          color: 'var(--text-muted)',
          opacity: 0.5,
        };
      default:
        return {
          background: 'var(--bg-secondary)',
          border: '2px solid transparent',
          cursor: 'not-allowed',
          opacity: 0.5,
        };
    }
  }

  // ----------------------------------------------------------
  // RENDER
  // ----------------------------------------------------------
  if (loading) {
    return (
      <div className="page-container py-20 text-center">
        <div className="spinner mx-auto mb-4" style={{ width: 48, height: 48 }}></div>
        <p style={{ color: 'var(--text-muted)' }}>Setting up your booking session...</p>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="page-container py-20 text-center">
        <div className="text-5xl mb-4">😕</div>
        <h2 className="text-xl font-bold mb-2">Cannot start booking</h2>
        <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>{error}</p>
        <a href={`/events/${eventId}`} className="btn-primary no-underline">
          Back to Event
        </a>
      </div>
    );
  }

  const selectedSeatDetails = seats.filter(s => selectedSeats.includes(s.seat_id));
  const totalPrice = selectedSeatDetails.reduce((sum, s) => sum + s.price, 0);
  const isExpired = timeLeft <= 0;
  const filteredSeats = seats.filter(s => s.section === activeSection);

  // Group filtered seats by row
  const rows = {};
  filteredSeats.forEach(s => {
    if (!rows[s.row_label]) rows[s.row_label] = [];
    rows[s.row_label].push(s);
  });
  // Sort seats within each row
  Object.values(rows).forEach(row => row.sort((a, b) => a.seat_number - b.seat_number));

  return (
    <div className="page-container py-6 animate-fade-in">

      {/* ---- Header + Timer ---- */}
      <div className="flex items-center justify-between mb-6">
        <button onClick={handleBackToEvent}
              className="text-sm"
              style={{ color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer' }}>
          ← Back to Event
        </button>

        <div className="flex items-center gap-3">
          <div className="px-4 py-2 rounded-xl font-mono font-bold text-lg"
            style={{
              background: isExpired
                ? 'linear-gradient(135deg, #ef4444, #dc2626)'
                : timeLeft < 60
                  ? 'linear-gradient(135deg, #f59e0b, #d97706)'
                  : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              color: 'white',
            }}>
            ⏱️ {formatTime(timeLeft)}
          </div>
        </div>
      </div>

      <h1 className="text-2xl font-bold mb-4">Select Your Seats</h1>

      {error && <div className="error-message mb-4">{error}</div>}
      {seatError && (
        <div className="p-3 rounded-lg mb-4 text-sm"
          style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
          {seatError}
        </div>
      )}

      {/* ---- Legend ---- */}
      <div className="flex items-center gap-4 mb-6 text-xs flex-wrap">
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded" style={{ border: '2px solid var(--border-primary)' }}></div>
          <span>Available</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded" style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}></div>
          <span>Your Selection</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded" style={{ background: 'var(--bg-secondary)', opacity: 0.5 }}></div>
          <span>Unavailable</span>
        </div>
      </div>

      {/* ---- Section Tabs ---- */}
      <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
        {sections.map(section => (
          <button key={section}
            onClick={() => setActiveSection(section)}
            className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
              activeSection === section ? 'text-white' : ''
            }`}
            style={{
              background: activeSection === section
                ? 'linear-gradient(135deg, #6366f1, #8b5cf6)'
                : 'var(--bg-secondary)',
              color: activeSection === section ? 'white' : 'var(--text-primary)',
            }}>
            {section}
          </button>
        ))}
      </div>

      {/* ---- Stage Indicator ---- */}
      <div className="text-center mb-6 py-2 px-6 rounded-lg text-xs font-bold uppercase"
        style={{
          background: 'var(--bg-secondary)',
          color: 'var(--text-muted)',
          letterSpacing: '0.2em',
        }}>
        ◆ STAGE ◆
      </div>

      {/* ---- Seat Grid ---- */}
      <div className="mb-8">
        {Object.entries(rows).map(([rowLabel, rowSeats]) => (
          <div key={rowLabel} className="flex items-center gap-2 mb-2">
            <span className="w-8 text-xs font-bold text-right"
              style={{ color: 'var(--text-muted)' }}>
              {rowLabel}
            </span>
            <div className="flex gap-1.5 flex-wrap">
              {rowSeats.map(seat => (
                <button key={seat.seat_id}
                  onClick={() => {
                    if (seat.state === 'AVAILABLE' || seat.state === 'HELD_BY_YOU') {
                      handleSeatClick(seat);
                    }
                  }}
                  disabled={seat.state === 'BOOKED' || seat.state === 'HELD_BY_OTHER' || isExpired}
                  className="w-9 h-9 rounded text-xs font-medium transition-all hover:scale-110"
                  style={getSeatStyle(seat)}
                  title={`${seat.section} Row ${seat.row_label} Seat ${seat.seat_number} — ₹${seat.price}`}
                >
                  {seat.seat_number}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ---- Selection Summary + Proceed ---- */}
      {selectedSeats.length > 0 && (
        <div className="card p-5 sticky bottom-4"
          style={{
            background: 'var(--bg-primary)',
            boxShadow: '0 -4px 20px rgba(0,0,0,0.2)',
          }}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <span className="font-bold">{selectedSeats.length} seat{selectedSeats.length > 1 ? 's' : ''}</span>
              <span className="text-sm ml-2" style={{ color: 'var(--text-secondary)' }}>
                {selectedSeatDetails.map(s => `${s.section} ${s.row_label}${s.seat_number}`).join(', ')}
              </span>
            </div>
            <span className="text-xl font-bold" style={{ color: 'var(--color-primary)' }}>
              ₹{totalPrice.toLocaleString()}
            </span>
          </div>

          <button
            onClick={handleProceed}
            disabled={proceeding || isExpired}
            className="btn-primary w-full py-3 font-bold text-base"
          >
            {proceeding ? 'Processing...' : `Proceed to Payment →`}
          </button>
        </div>
      )}
    </div>
  );
}
