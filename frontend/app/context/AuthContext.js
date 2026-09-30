// ============================================================
// AuthContext.js — Global authentication state management
//
// This React context provides authentication state (user info,
// token, login/logout functions) to every component in the app
// without prop-drilling.
//
// HOW IT WORKS:
//   1. On app load, checks localStorage for an existing token
//   2. If a token exists, decodes it to get user info (id, role)
//   3. Provides user, login, logout, and loading state to all children
//
// USAGE in any component:
//   'use client';
//   import { useAuth } from '@/app/context/AuthContext';
//
//   function MyComponent() {
//     const { user, login, logout, loading } = useAuth();
//     if (user) { /* logged in */ }
//   }
//
// WHY a context (not just localStorage directly):
//   When a user logs in or out, EVERY component that depends
//   on auth state needs to re-render (e.g., Navbar shows "Login"
//   vs the user's name). React context triggers this re-render
//   automatically; reading localStorage directly does not.
// ============================================================

'use client';

import { createContext, useContext, useState, useEffect } from 'react';

// Create the context with a default value of null.
// Components that try to use this context outside of the
// provider will get null, which is a clear signal something
// is wrong (the provider is missing from the tree).
const AuthContext = createContext(null);


// ============================================================
// decodeToken(token)
// ============================================================
// JWTs have three parts separated by dots: header.payload.signature
// The payload (middle part) is a base64-encoded JSON string.
// We decode it to extract the user's id and role without
// needing a server round-trip.
//
// NOTE: This is NOT verification — we're not checking the
// signature here. The backend verifies the signature on every
// request. This is just for reading "who is this user" on the
// frontend for UI purposes (showing their name, hiding
// organizer-only buttons, etc.).
// ============================================================
function decodeToken(token) {
  try {
    // Split the JWT into its 3 parts and take the payload (index 1)
    const payload = token.split('.')[1];

    // atob() decodes base64 → string, then parse as JSON
    const decoded = JSON.parse(atob(payload));

    return decoded; // { id, role, iat, exp }
  } catch {
    return null; // Token is malformed — treat as not logged in
  }
}


// ============================================================
// AuthProvider — Wraps the entire app to provide auth state
// ============================================================
// This component:
//   1. Initializes auth state from localStorage on mount
//   2. Provides login() — saves token + user, updates state
//   3. Provides logout() — clears token + user, updates state
//   4. Provides user object and loading flag to all children
// ============================================================
export function AuthProvider({ children }) {
  // user: null (not logged in) or { id, name, email, role }
  const [user, setUser] = useState(null);

  // loading: true while we're checking localStorage on first load.
  // Components should show a loading state (or nothing) while
  // this is true, rather than flashing "Login" briefly before
  // realizing the user IS logged in.
  const [loading, setLoading] = useState(true);

  // ----------------------------------------------------------
  // On first mount: check if a token exists in localStorage.
  // If it does, decode it and restore the user's session.
  // This is what makes "stay logged in across page refreshes" work.
  // ----------------------------------------------------------
  useEffect(() => {
    const token = localStorage.getItem('token');
    const storedUser = localStorage.getItem('user');

    if (token && storedUser) {
      try {
        // Verify the token hasn't expired by checking the exp claim.
        const decoded = decodeToken(token);
        const now = Date.now() / 1000; // current time in seconds

        if (decoded && decoded.exp > now) {
          // Token is still valid — restore the session
          setUser(JSON.parse(storedUser));
        } else {
          // Token has expired — clean up
          localStorage.removeItem('token');
          localStorage.removeItem('user');
        }
      } catch {
        // Corrupted data in localStorage — clean up
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
    }

    setLoading(false);
  }, []);


  // ----------------------------------------------------------
  // login(token, userData)
  // ----------------------------------------------------------
  // Called after a successful signup or login API call.
  // Saves the token and user info to both state and localStorage.
  //
  // Parameters:
  //   token — the JWT string from the backend
  //   userData — { id, name, email, role } from the backend
  // ----------------------------------------------------------
  function login(token, userData) {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(userData));
    setUser(userData);
  }


  // ----------------------------------------------------------
  // logout()
  // ----------------------------------------------------------
  // Clears all auth state. After this, the user is treated as
  // not logged in and any API requests will fail with 401.
  // ----------------------------------------------------------
  function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  }


  return (
    <AuthContext.Provider value={{ user, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}


// ============================================================
// useAuth() — Custom hook for consuming auth context
// ============================================================
// Components call useAuth() instead of useContext(AuthContext)
// directly. This gives us a single place to add error handling
// if the hook is used outside the provider.
// ============================================================
export function useAuth() {
  const context = useContext(AuthContext);

  if (context === null) {
    throw new Error('useAuth() must be used inside an <AuthProvider>. Check your layout.js.');
  }

  return context;
}
