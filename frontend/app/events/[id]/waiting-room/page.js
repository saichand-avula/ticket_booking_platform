// ============================================================
// Waiting Room Page — /events/[id]/waiting-room
//
// When a customer clicks "Buy Tickets", they land here first.
// The page calls POST /waiting-room/join:
//   - If admitted immediately → redirect to seat map
//   - If queued → show position, poll every 3 seconds
//
// Displays:
//   - Queue position ("12 people ahead of you")
//   - Animated waiting indicator
//   - Auto-redirects to seat map when admitted
// ============================================================

'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

export default function WaitingRoomPage() {
  const params = useParams();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const eventId = params.id;

  const [status, setStatus] = useState('joining'); // joining | queued | admitted | error
  const [position, setPosition] = useState(null);
  const [totalInQueue, setTotalInQueue] = useState(null);
  const [error, setError] = useState('');
  const pollRef = useRef(null);

  // ----------------------------------------------------------
  // Join the waiting room on mount
  // ----------------------------------------------------------
  useEffect(() => {
    if (authLoading) return;

    async function join() {
      try {
        const result = await api.post(`/events/${eventId}/waiting-room/join`);

        if (result.admitted) {
          // Admitted immediately — go to seat map
          setStatus('admitted');
          router.replace(`/events/${eventId}/seats`);
        } else {
          // Queued — show position and start polling
          setStatus('queued');
          setPosition(result.position);
          setTotalInQueue(result.totalInQueue);
          startPolling();
        }
      } catch (err) {
        setStatus('error');
        setError(err.message);
      }
    }

    join();

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [authLoading, eventId]);

  // ----------------------------------------------------------
  // Poll for position updates every 3 seconds
  // ----------------------------------------------------------
  function startPolling() {
    pollRef.current = setInterval(async () => {
      try {
        const result = await api.get(`/events/${eventId}/waiting-room/position`);

        if (result.admitted) {
          // We've been admitted! Stop polling and redirect.
          clearInterval(pollRef.current);
          setStatus('admitted');
          router.replace(`/events/${eventId}/seats`);
        } else {
          setPosition(result.position);
          setTotalInQueue(result.totalInQueue);
        }
      } catch {
        // Silently retry on next poll
      }
    }, 3000);
  }

  // ----------------------------------------------------------
  // RENDER
  // ----------------------------------------------------------

  // Joining state
  if (status === 'joining') {
    return (
      <div className="page-container py-20 text-center animate-fade-in">
        <div className="spinner mx-auto mb-4" style={{ width: 48, height: 48 }}></div>
        <h2 className="text-xl font-bold mb-2">Joining queue...</h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Checking availability
        </p>
      </div>
    );
  }

  // Error state
  if (status === 'error') {
    return (
      <div className="page-container py-20 text-center animate-fade-in">
        <div className="text-5xl mb-4">😕</div>
        <h2 className="text-xl font-bold mb-2">Could not join queue</h2>
        <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>{error}</p>
        <Link href={`/events/${eventId}`} className="btn-primary no-underline">
          Back to Event
        </Link>
      </div>
    );
  }

  // Admitted — brief flash before redirect
  if (status === 'admitted') {
    return (
      <div className="page-container py-20 text-center animate-fade-in">
        <div className="text-5xl mb-4">🎉</div>
        <h2 className="text-xl font-bold mb-2">You're in!</h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Redirecting to seat selection...
        </p>
      </div>
    );
  }

  // Queued — show position
  return (
    <div className="page-container py-12 text-center animate-fade-in max-w-md mx-auto">

      {/* Animated waiting icon */}
      <div className="mb-6">
        <div className="inline-block p-6 rounded-full mb-4"
          style={{
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            animation: 'pulse 2s infinite',
          }}>
          <span className="text-5xl">⏳</span>
        </div>
      </div>

      <h1 className="text-2xl font-bold mb-2">You're in the queue</h1>
      <p className="text-sm mb-8" style={{ color: 'var(--text-secondary)' }}>
        High demand! Please wait — you'll be redirected automatically.
      </p>

      {/* Position card */}
      <div className="card p-6 mb-6">
        <div className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>
          Your position
        </div>
        <div className="text-5xl font-bold mb-2" style={{ color: 'var(--color-primary)' }}>
          #{position}
        </div>
        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {position === 1
            ? "You're next!"
            : `${position - 1} ${position - 1 === 1 ? 'person' : 'people'} ahead of you`}
        </div>
        {totalInQueue && (
          <div className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            {totalInQueue} total in queue
          </div>
        )}
      </div>

      {/* Status indicator */}
      <div className="flex items-center justify-center gap-2 mb-8">
        <div className="w-2 h-2 rounded-full bg-green-500"
          style={{ animation: 'pulse 1.5s infinite' }}></div>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Checking every 3 seconds...
        </span>
      </div>

      {/* Leave queue */}
      <Link href={`/events/${eventId}`}
            className="text-sm no-underline"
            style={{ color: 'var(--text-secondary)' }}>
        ← Leave queue and go back
      </Link>

      {/* Pulse animation */}
      <style jsx>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(1.05); }
        }
      `}</style>
    </div>
  );
}
