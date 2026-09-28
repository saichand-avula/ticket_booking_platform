// ============================================================
// authRoutes.js — Route definitions for authentication
//
// All auth routes live under /api/auth (mounted in server.js).
//
// Routes:
//   POST /api/auth/customer/signup    → create customer account
//   POST /api/auth/customer/login     → log in as customer
//   POST /api/auth/organizer/signup   → create organizer account
//   POST /api/auth/organizer/login    → log in as organizer
//
// None of these require authentication (obviously — you can't
// be logged in before you've signed up or logged in).
// ============================================================

const express = require('express');
const router = express.Router();
const {
  customerSignup,
  customerLogin,
  organizerSignup,
  organizerLogin,
} = require('../controllers/authController');

// ----------------------------------------------------------
// Customer auth routes
// ----------------------------------------------------------
// POST /api/auth/customer/signup
// Body: { name, email, password, phone?, defaultLocation? }
router.post('/customer/signup', customerSignup);

// POST /api/auth/customer/login
// Body: { email, password }
router.post('/customer/login', customerLogin);

// ----------------------------------------------------------
// Organizer auth routes
// ----------------------------------------------------------
// POST /api/auth/organizer/signup
// Body: { name, email, password, phone? }
router.post('/organizer/signup', organizerSignup);

// POST /api/auth/organizer/login
// Body: { email, password }
router.post('/organizer/login', organizerLogin);

module.exports = router;
