// ============================================================
// authMiddleware.js — JWT verification and role enforcement
//
// This middleware sits between the router and the controller
// for any endpoint that requires authentication. It does:
//
//   1. Extracts the JWT from the Authorization header
//   2. Verifies the token's signature and expiry
//   3. Attaches the decoded user info (id, role) to req.user
//   4. Optionally checks if the user has the required role
//
// USAGE in route files:
//
//   const { authenticate, requireRole } = require('../middleware/authMiddleware');
//
//   // Any logged-in user can access this:
//   router.get('/profile', authenticate, getProfile);
//
//   // Only organizers can access this:
//   router.post('/events', authenticate, requireRole('organizer'), createEvent);
//
//   // Only customers can access this:
//   router.post('/orders', authenticate, requireRole('customer'), createOrder);
//
// HOW THE TOKEN TRAVELS:
//   The frontend sends the JWT in every request's Authorization
//   header like this:
//     Authorization: Bearer eyJhbGciOiJI...
//   This middleware reads that header, strips the "Bearer " prefix,
//   and verifies the remaining token string.
// ============================================================

const jwt = require('jsonwebtoken');


// ============================================================
// authenticate(req, res, next)
// ============================================================
// The core middleware. Verifies the JWT and attaches the decoded
// payload to req.user. If the token is missing, expired, or
// tampered with, it returns a 401 Unauthorized response and
// the request never reaches the controller.
//
// After this middleware runs successfully, any downstream
// handler can access:
//   req.user.id   → the user's database ID (customer_id or org_id)
//   req.user.role → "customer" or "organizer"
// ============================================================
function authenticate(req, res, next) {
  // ----------------------------------------------------------
  // Step 1: Extract the token from the Authorization header.
  //
  // The header format is: "Bearer <token>"
  // We split on the space and take the second part.
  // If there's no header at all, or it doesn't start with
  // "Bearer", we reject immediately.
  // ----------------------------------------------------------
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Authentication required. Send a JWT in the Authorization header as: Bearer <token>',
    });
  }

  // Extract just the token part (everything after "Bearer ")
  const token = authHeader.split(' ')[1];

  try {
    // ----------------------------------------------------------
    // Step 2: Verify the token.
    //
    // jwt.verify() does three things:
    //   a) Checks the signature — was this token actually signed
    //      by our server's JWT_SECRET, or was it forged?
    //   b) Checks the expiry — has the token's "exp" claim
    //      passed? (We set expiresIn: '7d' during signup/login)
    //   c) Decodes the payload — extracts { id, role, iat, exp }
    //
    // If any of these checks fail, it throws a JsonWebTokenError
    // or TokenExpiredError, which we catch below.
    // ----------------------------------------------------------
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ----------------------------------------------------------
    // Step 3: Attach the decoded user info to the request.
    //
    // This is the standard Express pattern for passing data
    // between middleware and route handlers. After this line,
    // any controller can do req.user.id or req.user.role.
    // ----------------------------------------------------------
    req.user = {
      id: decoded.id,
      role: decoded.role,
    };

    // ----------------------------------------------------------
    // Step 4: Call next() to pass control to the next middleware
    // or the route handler. Without this, the request would
    // hang forever — Express doesn't auto-advance.
    // ----------------------------------------------------------
    next();
  } catch (err) {
    // Token verification failed. Two common cases:
    //   - TokenExpiredError: the token was valid but has expired
    //   - JsonWebTokenError: the token was tampered with or
    //     signed with a different secret
    // We return 401 for both — the user needs to log in again.
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token has expired. Please log in again.',
      });
    }

    return res.status(401).json({
      error: 'Invalid token. Please log in again.',
    });
  }
}


// ============================================================
// requireRole(...roles)
// ============================================================
// A higher-order middleware factory. Call it with one or more
// role names, and it returns a middleware function that checks
// if the authenticated user has one of those roles.
//
// This MUST be used AFTER authenticate — it expects req.user
// to already be populated.
//
// Examples:
//   requireRole('organizer')           → only organizers
//   requireRole('customer')            → only customers
//   requireRole('customer', 'organizer') → either role
//
// If the user's role doesn't match, returns 403 Forbidden
// (not 401 — they ARE authenticated, they just don't have
// permission for this specific action).
// ============================================================
function requireRole(...roles) {
  return (req, res, next) => {
    // req.user should exist because authenticate ran first.
    // But if someone accidentally uses requireRole without
    // authenticate, we catch that too.
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required before role check.',
      });
    }

    // Check if the user's role is in the allowed list.
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. This endpoint requires one of these roles: ${roles.join(', ')}. Your role: ${req.user.role}.`,
      });
    }

    // Role matches — proceed to the controller.
    next();
  };
}


module.exports = { authenticate, requireRole };
