// ============================================================
// seed-cities.js — Seed the cities table
//
// Run: node scripts/seed-cities.js
//
// Inserts major Indian metro cities into the `cities` table.
// Safe to re-run — uses ON CONFLICT DO NOTHING so it won't
// duplicate rows if already seeded.
// ============================================================

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const cities = [
  { city_name: 'Bangalore',  state: 'Karnataka'    },
  { city_name: 'Mumbai',     state: 'Maharashtra'  },
  { city_name: 'Delhi',      state: 'Delhi'        },
  { city_name: 'Hyderabad',  state: 'Telangana'    },
  { city_name: 'Chennai',    state: 'Tamil Nadu'   },
  { city_name: 'Kolkata',    state: 'West Bengal'  },
  { city_name: 'Pune',       state: 'Maharashtra'  },
  { city_name: 'Ahmedabad',  state: 'Gujarat'      },
  { city_name: 'Jaipur',     state: 'Rajasthan'    },
  { city_name: 'Surat',      state: 'Gujarat'      },
  { city_name: 'Lucknow',    state: 'Uttar Pradesh'},
  { city_name: 'Kochi',      state: 'Kerala'       },
];

async function seedCities() {
  console.log('🌱 Seeding cities...\n');

  let inserted = 0;
  let skipped  = 0;

  for (const city of cities) {
    const result = await pool.query(
      `INSERT INTO cities (city_name, state)
       VALUES ($1, $2)
       ON CONFLICT (city_name) DO NOTHING
       RETURNING city_id, city_name, state`,
      [city.city_name, city.state]
    );

    if (result.rowCount > 0) {
      const { city_id, city_name, state } = result.rows[0];
      console.log(`  ✅ [${city_id}] ${city_name}, ${state}`);
      inserted++;
    } else {
      console.log(`  ⏭️  Skipped (already exists): ${city.city_name}`);
      skipped++;
    }
  }

  console.log(`\n✔ Done — ${inserted} inserted, ${skipped} skipped.`);

  // Print the final table
  const all = await pool.query('SELECT city_id, city_name, state FROM cities ORDER BY city_id');
  console.log('\n📋 Current cities table:');
  console.table(all.rows);

  await pool.end();
}

seedCities().catch(err => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
