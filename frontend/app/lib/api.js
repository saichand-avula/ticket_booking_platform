// ============================================================
// api.js — Centralized API client for the backend
//
// Every frontend component that needs to talk to the backend
// should use this module instead of calling fetch() directly.
//
// WHY:
//   1. Automatically attaches the JWT token to every request
//      (so individual components don't have to manage headers)
//   2. Centralizes the backend URL in one place
//   3. Standardizes error handling across all API calls
//   4. Makes it easy to swap the HTTP client later if needed
//
// USAGE:
//   import api from '@/app/lib/api';
//
//   // GET request:
//   const events = await api.get('/events');
//
//   // POST request with body:
//   const result = await api.post('/auth/customer/login', { email, password });
//
//   // PATCH request:
//   await api.patch('/events/1/pricing', { section: 'VIP', price: 200 });
// ============================================================

// The backend URL. In development, the Express server runs on
// port 8002 while Next.js runs on port 3000. In production,
// this would be the deployed backend URL (e.g. on Railway).
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8002/api';


// ============================================================
// getToken()
// ============================================================
// Reads the JWT from localStorage. Returns null if no token
// exists (user is not logged in).
//
// We store the token in localStorage (not cookies) because:
//   - It's simpler for a single-page app
//   - The token is sent via Authorization header, not cookies
//   - We control when it's sent (only to our own API)
// ============================================================
function getToken() {
  if (typeof window === 'undefined') return null; // SSR safety
  return localStorage.getItem('token');
}


// ============================================================
// request(method, path, body)
// ============================================================
// The core function that all methods (get, post, patch, delete)
// delegate to. Handles:
//   - Building the full URL from the path
//   - Setting Content-Type and Authorization headers
//   - Parsing the JSON response
//   - Throwing on non-OK responses with the server's error message
// ============================================================
async function request(method, path, body = null) {
  // Build headers. Always include Content-Type for POST/PATCH.
  // Include Authorization if a token exists in localStorage.
  const headers = {
    'Content-Type': 'application/json',
  };

  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Build the fetch options.
  const options = {
    method,
    headers,
    cache: 'no-store', // Prevent aggressive Next.js/browser caching of API data
  };

  // Only include a body for methods that support it.
  // GET typically doesn't have a request body.
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  // Make the request.
  const response = await fetch(`${API_BASE}${path}`, options);

  // Parse the JSON response.
  // We clone the response before parsing in case the body is
  // empty (e.g., 204 No Content), which would throw on .json().
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  // If the response is not OK (status 400, 401, 403, 404, 500, etc.),
  // throw an error with the server's error message so the calling
  // component can display it to the user.
  if (!response.ok) {
    const errorMessage = data?.error || data?.message || `Request failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  return data;
}


// ============================================================
// Convenience methods — thin wrappers around request()
// ============================================================
const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  delete: (path, body) => request('DELETE', path, body),
};

export default api;
