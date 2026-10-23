// ============================================================
// Customer Signup Page — /auth/signup
//
// A registration form for new customers. Collects:
//   - Name (required)
//   - Email (required)
//   - Password (required)
//   - Phone (optional)
//   - Default City (required — picked from a dropdown, pre-fills
//     the event listing's city filter on every login)
//
// The city dropdown is populated from GET /api/cities on page
// load — NOT hardcoded in the frontend. This means the list of
// selectable cities always matches whatever the backend's
// `cities` table currently contains, so adding a new city later
// (a simple database INSERT) shows up here automatically with
// no frontend code change needed.
//
// On success, automatically logs the user in (saves the JWT)
// and redirects to the events page — no need to log in again
// after signing up.
// ============================================================

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

export default function CustomerSignupPage() {
  const router = useRouter();
  const { login } = useAuth();

  // Form state
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [defaultCityId, setDefaultCityId] = useState('');

  // City dropdown data — fetched once on mount from the public
  // /api/cities endpoint (no auth needed, since the user isn't
  // logged in yet at signup time).
  const [cities, setCities] = useState([]);
  const [citiesLoading, setCitiesLoading] = useState(true);

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // ----------------------------------------------------------
  // Fetch the list of cities once, when the page first loads.
  // This populates the <select> dropdown below. An empty
  // dependency array ([]) means this effect runs exactly once,
  // not on every re-render.
  // ----------------------------------------------------------
  useEffect(() => {
    async function fetchCities() {
      try {
        const data = await api.get('/cities');
        setCities(data);
      } catch (err) {
        // Non-fatal: the form still works, the dropdown will just
        // be empty and the user will see the error above the form.
        setError('Could not load city list. Please refresh the page.');
      } finally {
        setCitiesLoading(false);
      }
    }

    fetchCities();
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Call the backend signup endpoint.
      // The backend hashes the password, creates the customer,
      // and returns a JWT + user info (including the resolved
      // city name for defaultCityId, so the UI can display it
      // immediately without a second lookup).
      const data = await api.post('/auth/customer/signup', {
        name,
        email,
        password,
        phone: phone || undefined,
        defaultCityId: defaultCityId || undefined,
      });

      // Auto-login: save the token and redirect.
      // The user doesn't need to go to the login page after signing up.
      login(data.token, data.user);
      router.push('/events');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-container flex items-center justify-center min-h-[80vh]">
      <div className="card p-8 w-full max-w-md animate-fade-in">

        {/* ---- Header ---- */}
        <h1 className="text-2xl font-bold mb-2">Create your account</h1>
        <p className="text-sm mb-8" style={{ color: 'var(--text-secondary)' }}>
          Sign up to browse events and book tickets
        </p>

        {/* ---- Signup Form ---- */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">

          {/* Name */}
          <div>
            <label htmlFor="signup-name" className="label">Full Name</label>
            <input
              id="signup-name"
              type="text"
              className="input"
              placeholder="Vishal Reddy"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          {/* Email */}
          <div>
            <label htmlFor="signup-email" className="label">Email</label>
            <input
              id="signup-email"
              type="email"
              className="input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          {/* Password */}
          <div>
            <label htmlFor="signup-password" className="label">Password</label>
            <input
              id="signup-password"
              type="password"
              className="input"
              placeholder="At least 6 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
            />
          </div>

          {/* Phone (optional) */}
          <div>
            <label htmlFor="signup-phone" className="label">
              Phone <span style={{ color: 'var(--text-muted)' }}>(optional)</span>
            </label>
            <input
              id="signup-phone"
              type="tel"
              className="input"
              placeholder="9876543210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>

          {/* Default City — required, picked from a dropdown fed
              by GET /api/cities. This becomes the city the event
              listing filters by default whenever this customer
              logs in. */}
          <div>
            <label htmlFor="signup-city" className="label">
              Default City <span style={{ color: 'var(--text-muted)' }}>(used to pre-filter events near you)</span>
            </label>
            <select
              id="signup-city"
              className="input"
              value={defaultCityId}
              onChange={(e) => setDefaultCityId(e.target.value)}
              required
              disabled={citiesLoading}
            >
              <option value="" disabled>
                {citiesLoading ? 'Loading cities…' : 'Select your city'}
              </option>
              {cities.map((c) => (
                <option key={c.city_id} value={c.city_id}>
                  {c.city_name}{c.state ? `, ${c.state}` : ''}
                </option>
              ))}
            </select>
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" className="btn-primary mt-2" disabled={loading}>
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="spinner" style={{ width: 18, height: 18 }}></span>
                Creating account...
              </span>
            ) : (
              'Create Account'
            )}
          </button>
        </form>

        {/* ---- Footer links ---- */}
        <div className="mt-6 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          Already have an account?{' '}
          <Link href="/auth/login" className="font-medium" style={{ color: 'var(--color-primary)' }}>
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
