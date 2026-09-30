// ============================================================
// Navbar.js — Top navigation bar
//
// Uses a DARK header bar (deep indigo/slate) which contrasts
// nicely against the light page background. This is the pattern
// used by apps like Linear, GitHub, and Vercel — dark nav,
// light content.
//
// Shows different links depending on who is logged in:
//   - Not logged in: "Login" and "Sign Up" buttons
//   - Customer: "Events", "My Tickets", user name, "Logout"
//   - Organizer: "Dashboard", "Create Event", user name, "Logout"
// ============================================================

'use client';

import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import { useRouter } from 'next/navigation';

export default function Navbar() {
  const { user, logout, loading } = useAuth();
  const router = useRouter();

  // ----------------------------------------------------------
  // handleLogout — clears auth state and redirects to home
  // ----------------------------------------------------------
  function handleLogout() {
    logout();
    router.push('/');
  }

  // Don't render anything while checking localStorage on first load.
  if (loading) return null;

  return (
    <nav
      className="sticky top-0 z-50"
      style={{
        background: 'linear-gradient(135deg, #1e1b4b, #312e81)',
        boxShadow: '0 2px 12px rgba(0, 0, 0, 0.15)',
      }}
    >
      <div className="page-container flex items-center justify-between py-3.5">

        {/* ---- Logo / Brand ---- */}
        <Link href="/" className="flex items-center gap-2.5 no-underline">
          <span className="text-2xl">🎫</span>
          <span
            className="text-xl font-bold"
            style={{
              background: 'linear-gradient(135deg, #a5b4fc, #f0abfc)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            EventTix
          </span>
        </Link>

        {/* ---- Navigation Links ---- */}
        <div className="flex items-center gap-3">

          {!user ? (
            // ---------------------------------------------------
            // NOT LOGGED IN — show login/signup options
            // ---------------------------------------------------
            <>
              <Link
                href="/events"
                className="text-sm no-underline px-3 py-1.5 rounded-lg transition-colors"
                style={{ color: '#c7d2fe' }}
                onMouseEnter={(e) => e.target.style.color = '#ffffff'}
                onMouseLeave={(e) => e.target.style.color = '#c7d2fe'}
              >
                Browse Events
              </Link>
              <Link
                href="/auth/login"
                className="text-sm no-underline px-4 py-2 rounded-lg font-medium transition-all"
                style={{
                  color: '#c7d2fe',
                  border: '1px solid rgba(199, 210, 254, 0.3)',
                }}
              >
                Login
              </Link>
              <Link
                href="/auth/signup"
                className="text-sm no-underline px-4 py-2 rounded-lg font-medium"
                style={{
                  background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  color: 'white',
                  boxShadow: '0 2px 8px rgba(99, 102, 241, 0.4)',
                }}
              >
                Sign Up
              </Link>
            </>
          ) : user.role === 'customer' ? (
            // ---------------------------------------------------
            // CUSTOMER
            // ---------------------------------------------------
            <>
              <Link href="/events" className="text-sm no-underline px-3 py-1.5 rounded-lg"
                    style={{ color: '#c7d2fe' }}>
                Events
              </Link>
              <Link href="/my-tickets" className="text-sm no-underline px-3 py-1.5 rounded-lg"
                    style={{ color: '#c7d2fe' }}>
                My Tickets
              </Link>
              <span className="text-sm px-2" style={{ color: '#a5b4fc' }}>
                👤 {user.name}
              </span>
              <button
                onClick={handleLogout}
                className="text-sm px-4 py-2 rounded-lg font-medium cursor-pointer transition-all"
                style={{
                  color: '#fda4af',
                  border: '1px solid rgba(253, 164, 175, 0.3)',
                  background: 'transparent',
                }}
              >
                Logout
              </button>
            </>
          ) : (
            // ---------------------------------------------------
            // ORGANIZER
            // ---------------------------------------------------
            <>
              <Link href="/organizer/dashboard" className="text-sm no-underline px-3 py-1.5 rounded-lg"
                    style={{ color: '#c7d2fe' }}>
                Dashboard
              </Link>
              <Link href="/organizer/venues/create" className="text-sm no-underline px-3 py-1.5 rounded-lg"
                    style={{ color: '#c7d2fe' }}>
                Create Venue
              </Link>
              <Link href="/organizer/events/create" className="text-sm no-underline px-3 py-1.5 rounded-lg"
                    style={{ color: '#c7d2fe' }}>
                Create Event
              </Link>
              <span className="text-sm px-2" style={{ color: '#a5b4fc' }}>
                🏢 {user.name}
              </span>
              <button
                onClick={handleLogout}
                className="text-sm px-4 py-2 rounded-lg font-medium cursor-pointer transition-all"
                style={{
                  color: '#fda4af',
                  border: '1px solid rgba(253, 164, 175, 0.3)',
                  background: 'transparent',
                }}
              >
                Logout
              </button>
            </>
          )}

        </div>
      </div>
    </nav>
  );
}
