// ============================================================
// cityRoutes.js — Route definitions for city lookups
//
// Mounted at /api/cities in server.js.
//
// Routes:
//   GET /api/cities → list all cities (public, no auth required)
// ============================================================

const express = require('express');
const router = express.Router();
const { listCitiesHandler } = require('../controllers/cityController');

// No `authenticate` middleware here on purpose — see the comment
// in cityController.js for why this must stay public.
router.get('/', listCitiesHandler);

module.exports = router;
