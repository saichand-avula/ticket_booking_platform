// ============================================================
// Organizer Login/Signup Page — /organizer/login
//
// A combined login + signup page for event organizers.
// Uses a tab toggle to switch between "Sign In" and "Sign Up"
// modes. This keeps the organizer auth flow in one place.
//
// After successful login/signup, redirects to the organizer
// dashboard at /organizer/dashboard.
// ============================================================

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

export default function OrganizerLoginPage() {
  const router = useRouter();
  const { login } = useAuth();

  // Toggle between "login" and "signup" mode
  const [mode, setMode] = useState('login');

  // Form state
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let data;

      if (mode === 'login') {
        // Login — POST /api/auth/organizer/login
        data = await api.post('/auth/organizer/login', { email, password });
      } else {
        // Signup — POST /api/auth/organizer/signup
        data = await api.post('/auth/organizer/signup', {
          name,
          email,
          password,
          phone: phone || undefined,
        });
      }

      // Save token and redirect to organizer dashboard
      login(data.token, data.user);
      router.push('/organizer/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Clear error when switching modes
  function switchMode(newMode) {
    setMode(newMode);
    setError('');
  }

  return (
    <div className="page-container flex items-center justify-center min-h-[80vh]">
      <div className="card p-8 w-full max-w-md animate-fade-in">

        {/* ---- Header ---- */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-2xl">🏢</span>
          <h1 className="text-2xl font-bold">Organizer Portal</h1>
        </div>
        <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
          Create and manage your events
        </p>

        {/* ---- Mode Toggle (Login / Signup tabs) ---- */}
        <div className="flex rounded-lg overflow-hidden mb-6"
             style={{ border: '1px solid var(--border-color)' }}>
          <button
            onClick={() => switchMode('login')}
            className="flex-1 py-2.5 text-sm font-medium transition-all"
            style={{
              background: mode === 'login' ? 'var(--color-primary)' : 'transparent',
              color: mode === 'login' ? 'white' : 'var(--text-secondary)',
            }}
          >
            Sign In
          </button>
          <button
            onClick={() => switchMode('signup')}
            className="flex-1 py-2.5 text-sm font-medium transition-all"
            style={{
              background: mode === 'signup' ? 'var(--color-primary)' : 'transparent',
              color: mode === 'signup' ? 'white' : 'var(--text-secondary)',
            }}
          >
            Sign Up
          </button>
        </div>

        {/* ---- Form ---- */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">

          {/* Organization Name (signup only) */}
          {mode === 'signup' && (
            <div>
              <label htmlFor="org-name" className="label">Organization Name</label>
              <input
                id="org-name"
                type="text"
                className="input"
                placeholder="Event Corp Pvt Ltd"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
          )}

          {/* Email */}
          <div>
            <label htmlFor="org-email" className="label">Email</label>
            <input
              id="org-email"
              type="email"
              className="input"
              placeholder="admin@eventcorp.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          {/* Password */}
          <div>
            <label htmlFor="org-password" className="label">Password</label>
            <input
              id="org-password"
              type="password"
              className="input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </div>

          {/* Phone (signup only, optional) */}
          {mode === 'signup' && (
            <div>
              <label htmlFor="org-phone" className="label">
                Phone <span style={{ color: 'var(--text-muted)' }}>(optional)</span>
              </label>
              <input
                id="org-phone"
                type="tel"
                className="input"
                placeholder="9876543210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          )}

          {error && <div className="error-message">{error}</div>}

          <button type="submit" className="btn-primary mt-2" disabled={loading}>
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="spinner" style={{ width: 18, height: 18 }}></span>
                {mode === 'login' ? 'Signing in...' : 'Creating account...'}
              </span>
            ) : (
              mode === 'login' ? 'Sign In' : 'Create Organizer Account'
            )}
          </button>
        </form>

        {/* ---- Footer link ---- */}
        <div className="mt-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          Looking to buy tickets?{' '}
          <Link href="/auth/login" className="font-medium" style={{ color: 'var(--color-primary)' }}>
            Customer login →
          </Link>
        </div>
      </div>
    </div>
  );
}
