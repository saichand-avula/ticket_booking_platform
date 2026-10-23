// backend/testConnection.js — throwaway file, delete after checking
const pool = require('./src/config/db');

pool.query('SELECT NOW()')
  .then(res => console.log('Connected. DB time:', res.rows[0].now))
  .catch(err => console.error('Connection failed:', err))
  .finally(() => pool.end());