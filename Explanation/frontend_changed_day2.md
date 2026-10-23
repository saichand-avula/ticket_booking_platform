City Dropdown Feature — File Bundle
====================================

This folder mirrors your repo's structure exactly. Copy these files
into your local Event-Ticketing-Platform repo at the matching paths,
overwriting the existing ones (or adding new ones where noted).

NEW FILES (create these):
  backend/migrations/003_cities_lookup_table.sql
  backend/src/service/cityService.js
  backend/src/controllers/cityController.js
  backend/src/routes/cityRoutes.js

MODIFIED FILES (overwrite existing ones):
  backend/server.js
  backend/src/service/venueService.js
  backend/src/controllers/venueController.js
  backend/src/service/authService.js
  backend/src/controllers/authController.js
  backend/src/service/eventService.js
  backend/src/controllers/eventController.js
  frontend/app/auth/signup/page.js
  frontend/app/events/page.js
  frontend/app/components/EventCard.js
  frontend/app/organizer/events/[id]/page.js
  frontend/app/organizer/events/create/page.js

STEPS TO APPLY
--------------
1. Copy all files above into your local repo at matching paths.

2. Run the new migration against your Neon/Supabase database:
     psql "$DATABASE_URL" -f backend/migrations/003_cities_lookup_table.sql
   (or run it through whatever migration runner / SQL editor you're
   already using for migrations 001 and 002)

3. Restart your backend:
     cd backend && npm run dev

4. Restart your frontend:
     cd frontend && npm run dev

5. Test the flow:
   a. GET http://localhost:5000/api/cities — should return the 8
      seeded metro cities.
   b. Sign up a new customer — the "Default City" field should now
      be a dropdown, not a text box.
   c. Log in as that customer, go to /events — the city filter
      should default to the city you picked at signup.
   d. Log in as an organizer, go to /organizer/events/create,
      switch to "Create new venue" — the City field should be a
      required dropdown.

6. Commit and push:
     git add .
     git commit -m "Replace free-text city with a cities lookup table + dropdowns"
     git push

NOTE: If you have existing venues or customers in your database
created BEFORE this migration, their city_id / default_city_id will
be NULL after the migration runs (the old free-text city data is
dropped, since there's no reliable way to auto-map "Bangalore" the
string to city_id 1 the row without you confirming the mapping).
For a dev database with test data only, the simplest fix is to just
delete and recreate those test rows through the app now that the
dropdowns exist.
