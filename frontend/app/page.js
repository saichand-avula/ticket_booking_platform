// ============================================================
// Landing Page — / (root)
//
// The homepage of EventTix. Designed with a warm, light aesthetic:
//   1. Hero with subtle gradient background
//   2. "How it works" cards with icons
//   3. Organizer CTA section
// ============================================================

import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="animate-fade-in">

      {/* ============================================================
          HERO SECTION
          Light gradient background, big headline, CTA buttons.
          ============================================================ */}
      <section
        className="py-24 text-center"
        style={{
          background: 'linear-gradient(180deg, #ede9fe 0%, #fafafa 100%)',
        }}
      >
        <div className="page-container max-w-3xl mx-auto">

          {/* Decorative badge */}
          <div
            className="inline-block mb-6 px-5 py-2.5 rounded-full text-sm font-semibold"
            style={{
              background: 'white',
              color: 'var(--color-primary)',
              boxShadow: 'var(--shadow-md)',
              border: '1px solid var(--border-color)',
            }}
          >
            🎫 Real-time seat-based ticketing
          </div>

          {/* Main headline */}
          <h1 className="text-5xl font-bold mb-6 leading-tight" style={{ color: 'var(--text-primary)' }}>
            Book Your Seats{' '}
            <span className="gradient-text">in Real Time</span>
          </h1>

          {/* Subtitle */}
          <p
            className="text-lg mb-10 leading-relaxed max-w-xl mx-auto"
            style={{ color: 'var(--text-secondary)' }}
          >
            Interactive seat maps, instant seat locking, and fair queuing.
            Never miss out on your favourite events again.
          </p>

          {/* CTA Buttons */}
          <div className="flex items-center justify-center gap-4">
            <Link href="/events" className="btn-primary text-base py-3.5 px-8 no-underline">
              Browse Events
            </Link>
            <Link href="/auth/signup" className="btn-secondary text-base py-3.5 px-8 no-underline">
              Create Account
            </Link>
          </div>
        </div>
      </section>


      {/* ============================================================
          HOW IT WORKS — Three-step cards
          ============================================================ */}
      <section className="page-container py-20">
        <h2 className="text-2xl font-bold text-center mb-3" style={{ color: 'var(--text-primary)' }}>
          How It Works
        </h2>
        <p className="text-center text-sm mb-12" style={{ color: 'var(--text-secondary)' }}>
          Three simple steps to your next live experience
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">

          {/* Step 1 */}
          <div className="card p-7 text-center" style={{ cursor: 'default' }}>
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl mb-5 mx-auto"
              style={{ background: '#ede9fe' }}
            >
              🔍
            </div>
            <h3 className="text-lg font-semibold mb-2">1. Find an Event</h3>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Browse upcoming concerts, sports, conferences and more.
              Filter by city, category, or date.
            </p>
          </div>

          {/* Step 2 */}
          <div className="card p-7 text-center" style={{ cursor: 'default' }}>
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl mb-5 mx-auto"
              style={{ background: '#fce7f3' }}
            >
              💺
            </div>
            <h3 className="text-lg font-semibold mb-2">2. Pick Your Seat</h3>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              View the live seat map. Click a seat to instantly lock it —
              it&apos;s held for you while you checkout.
            </p>
          </div>

          {/* Step 3 */}
          <div className="card p-7 text-center" style={{ cursor: 'default' }}>
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl mb-5 mx-auto"
              style={{ background: '#ecfdf5' }}
            >
              🎉
            </div>
            <h3 className="text-lg font-semibold mb-2">3. Get Your Ticket</h3>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Pay securely via Stripe. Your ticket and QR code are
              generated instantly — no waiting.
            </p>
          </div>
        </div>
      </section>


      {/* ============================================================
          FOR ORGANIZERS CTA
          ============================================================ */}
      <section className="page-container pb-20">
        <div
          className="card p-10 text-center max-w-2xl mx-auto"
          style={{
            cursor: 'default',
            background: 'linear-gradient(135deg, #eef2ff, #fdf2f8)',
            border: '1px solid #e0e7ff',
          }}
        >
          <h2 className="text-2xl font-bold mb-3" style={{ color: 'var(--text-primary)' }}>
            🏢 Are you an event organizer?
          </h2>
          <p className="text-sm mb-6 max-w-md mx-auto" style={{ color: 'var(--text-secondary)' }}>
            Create events, set your own seat pricing, manage sales in real time,
            and track revenue with our organizer dashboard.
          </p>
          <Link href="/organizer/login" className="btn-primary no-underline">
            Get Started as Organizer
          </Link>
        </div>
      </section>

    </div>
  );
}
