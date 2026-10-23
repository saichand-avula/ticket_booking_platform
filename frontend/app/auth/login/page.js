// ============================================================
// Customer Login Page — /auth/login
//
// A form that takes email + password, calls the backend's
// POST /api/auth/customer/login endpoint, and on success:
//   1. Saves the JWT token via AuthContext.login()
//   2. Redirects to the events page
//
// Also includes a link to sign up and a link to organizer login.
// ============================================================

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

export default function CustomerLoginPage() {
  const router = useRouter();
  const { login } = useAuth();

  // Form state — controlled inputs (React manages the values)
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // UI state — loading spinner and error display
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // ----------------------------------------------------------
  // handleSubmit — called when the form is submitted
  // ----------------------------------------------------------
  async function handleSubmit(e) {
    // Prevent the browser's default form submission (which would
    // cause a full page reload). We handle it via JavaScript.
    e.preventDefault();

    // Clear any previous error message
    setError('');
    setLoading(true);

    try {
      // Call the backend login endpoint.
      // On success, the backend returns { token, user }.
      const data = await api.post('/auth/customer/login', { email, password });

      // Save the token and user info in AuthContext + localStorage.
      // This triggers a re-render of the Navbar (showing the user's
      // name instead of "Login" button).
      login(data.token, data.user);

      // Redirect to the events browsing page.
      router.push('/events');
    } catch (err) {
      // Display the error message from the backend.
      // Common cases: "Invalid email or password", network errors.
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-container flex items-center justify-center min-h-[80vh]">
      <div className="card p-8 w-full max-w-md animate-fade-in">

        {/* ---- Header ---- */}
        <h1 className="text-2xl font-bold mb-2">Welcome back</h1>
        <p className="text-sm mb-8" style={{ color: 'var(--text-secondary)' }}>
          Sign in to your customer account
        </p>

        {/* ---- Login Form ---- */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">

          {/* Email field */}
          <div>
            <label htmlFor="login-email" className="label">Email</label>
            <input
              id="login-email"
              type="email"
              className="input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          {/* Password field */}
          <div>
            <label htmlFor="login-password" className="label">Password</label>
            <input
              id="login-password"
              type="password"
              className="input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>

          {/* Error message (shown only if there's an error) */}
          {error && <div className="error-message">{error}</div>}

          {/* Submit button */}
          <button
            type="submit"
            className="btn-primary mt-2"
            disabled={loading}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="spinner" style={{ width: 18, height: 18 }}></span>
                Signing in...
              </span>
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        {/* ---- Footer links ---- */}
        <div className="mt-6 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          Don&apos;t have an account?{' '}
          <Link href="/auth/signup" className="font-medium" style={{ color: 'var(--color-primary)' }}>
            Sign up
          </Link>
        </div>

        <div className="mt-3 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          Are you an event organizer?{' '}
          <Link href="/organizer/login" className="font-medium" style={{ color: 'var(--color-accent)' }}>
            Organizer login →
          </Link>
        </div>
      </div>
    </div>
  );
}
