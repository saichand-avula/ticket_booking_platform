// ============================================================
// authController.js — HTTP handlers for authentication
//
// This controller provides four endpoints:
//   POST /api/auth/customer/signup   → register a new customer
//   POST /api/auth/customer/login    → log in as customer
//   POST /api/auth/organizer/signup  → register a new organizer
//   POST /api/auth/organizer/login   → log in as organizer
//
// Each handler:
//   1. Validates the request body (are required fields present?)
//   2. Calls the auth service (which does the real work)
//   3. Returns the JWT token + user info on success
//   4. Returns a clear error message on failure
//
// WHY separate signup/login for customers vs organizers:
//   They go into different database tables with different fields.
//   Having separate endpoints makes the API explicit about which
//   type of account is being created/accessed, rather than
//   relying on a "role" field in the request body that could be
//   spoofed.
// ============================================================

const {
  signupCustomer,
  signupOrganizer,
  loginCustomer,
  loginOrganizer,
} = require('../service/authService');


// ============================================================
// customerSignup(req, res)
// ============================================================
// Registers a new customer account.
//
// Expected request body:
//   {
//     "name": "Vishal",
//     "email": "vishal@example.com",
//     "phone": "9876543210",   ← optional
//     "password": "securePassword",
//     "defaultCityId": 1       ← required, from GET /api/cities dropdown
//   }
//
// `defaultCityId` replaces the old free-text `defaultLocation`.
// It's required (not optional) because the design decision was:
// "by default filtering should be based on the address" — that
// only works if every customer actually has a city on record.
// The frontend fetches GET /api/cities to render the dropdown
// and sends back the chosen city's ID.
//
// Returns:
//   201 → { token, user: { id, name, email, role, defaultCityId,
//                           defaultCityName, createdAt } }
//   400 → { error: "..." } if validation fails or cityId invalid
//   409 → { error: "..." } if email already taken
// ============================================================
async function customerSignup(req, res) {
  const { name, email, password, phone, defaultCityId } = req.body;

  // ----------------------------------------------------------
  // Input validation — catch missing fields here in the
  // controller, before the service layer tries to run SQL
  // with null values and produces a confusing database error.
  // defaultCityId is now required, same as name/email/password.
  // ----------------------------------------------------------
  if (!name || !email || !password) {
    return res.status(400).json({
      error: 'Missing required fields: name, email, and password are all required.',
    });
  }

  if (!defaultCityId) {
    return res.status(400).json({
      error: 'Missing required field: "defaultCityId" is required. Fetch GET /api/cities to get valid options.',
    });
  }

  try {
    const result = await signupCustomer({ name, email, phone, password, defaultCityId });

    // 201 Created — the standard HTTP status for "a new
    // resource was successfully created."
    res.status(201).json(result);
  } catch (err) {
    // If the error is a Postgres unique constraint violation
    // (code 23505), it means the email is already registered.
    // We translate that into a user-friendly message instead
    // of exposing raw database errors.
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'An account with this email already exists.',
      });
    }

    // Foreign key violation (code 23503) means defaultCityId
    // doesn't match any real row in the cities table — e.g. a
    // stale or tampered ID from the frontend.
    if (err.code === '23503') {
      return res.status(400).json({
        error: 'Invalid defaultCityId — that city does not exist. Fetch GET /api/cities to get valid options.',
      });
    }

    console.error('Customer signup failed:', err);
    res.status(400).json({ error: err.message });
  }
}


// ============================================================
// customerLogin(req, res)
// ============================================================
// Authenticates an existing customer.
//
// Expected request body:
//   {
//     "email": "vishal@example.com",
//     "password": "securePassword"
//   }
//
// Returns:
//   200 → { token, user: { id, name, email, role } }
//   401 → { error: "Invalid email or password" }
// ============================================================
async function customerLogin(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      error: 'Missing required fields: email and password are both required.',
    });
  }

  try {
    const result = await loginCustomer({ email, password });
    res.json(result);
  } catch (err) {
    // Login failures always return 401 Unauthorized.
    // The service layer returns a generic "Invalid email or
    // password" message regardless of whether the email or
    // password was wrong — this prevents user enumeration.
    res.status(401).json({ error: err.message });
  }
}


// ============================================================
// organizerSignup(req, res)
// ============================================================
// Registers a new organizer account.
//
// Expected request body:
//   {
//     "name": "Event Corp",
//     "email": "admin@eventcorp.com",
//     "phone": "9876543210",         ← optional
//     "password": "securePassword"
//   }
//
// Returns:
//   201 → { token, user: { id, name, email, role, createdAt } }
//   400/409 → { error: "..." }
// ============================================================
async function organizerSignup(req, res) {
  const { name, email, password, phone } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({
      error: 'Missing required fields: name, email, and password are all required.',
    });
  }

  try {
    const result = await signupOrganizer({ name, email, phone, password });
    res.status(201).json(result);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'An organizer account with this email already exists.',
      });
    }

    console.error('Organizer signup failed:', err);
    res.status(400).json({ error: err.message });
  }
}


// ============================================================
// organizerLogin(req, res)
// ============================================================
// Authenticates an existing organizer.
//
// Expected request body:
//   {
//     "email": "admin@eventcorp.com",
//     "password": "securePassword"
//   }
//
// Returns:
//   200 → { token, user: { id, name, email, role } }
//   401 → { error: "Invalid email or password" }
// ============================================================
async function organizerLogin(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      error: 'Missing required fields: email and password are both required.',
    });
  }

  try {
    const result = await loginOrganizer({ email, password });
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
}


module.exports = {
  customerSignup,
  customerLogin,
  organizerSignup,
  organizerLogin,
};
