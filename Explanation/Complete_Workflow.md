# EventTix — Complete Project Workflow

> A real-time, seat-based event ticketing platform. This document explains the **complete architecture, data flow, and implementation** of everything built so far.

---

## 1. System Overview

```mermaid
flowchart TB
    subgraph "🌐 Frontend — Next.js 16 (port 3000)"
        FE_PAGES["16 Pages\n(Landing, Auth, Events, Dashboard, etc.)"]
        FE_API["api.js — HTTP client"]
        FE_AUTH["AuthContext — JWT state"]
    end

    subgraph "🔧 Backend — Express.js (port 5000)"
        ROUTES["Routes Layer\n(authRoutes, eventRoutes, venueRoutes)"]
        CONTROLLERS["Controller Layer\n(validation + HTTP responses)"]
        SERVICES["Service Layer\n(business logic + SQL queries)"]
        MIDDLEWARE["Middleware\n(JWT auth, role check, error handler)"]
    end

    subgraph "🗄️ Database — PostgreSQL"
        TABLES["Tables:\ncustomers, organizers,\nvenues, events,\nseats, event_section_pricing,\norders, order_items, tickets, payments"]
    end

    FE_PAGES --> FE_API
    FE_API -- "HTTP + JWT" --> ROUTES
    ROUTES --> MIDDLEWARE --> CONTROLLERS --> SERVICES --> TABLES

    style FE_PAGES fill:#ede9fe,stroke:#c4b5fd,color:#1e1b4b
    style ROUTES fill:#6366f1,stroke:#4f46e5,color:#fff
    style SERVICES fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style TABLES fill:#10b981,stroke:#059669,color:#fff
```

---

## 2. Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Next.js 16 (App Router) | Server components, file-based routing, React 19 |
| Styling | Tailwind CSS v4 + Vanilla CSS | Utility classes + custom design tokens |
| Backend | Express.js | Lightweight, well-known, great for REST APIs |
| Database | PostgreSQL | Relational data (events→venues→seats), ACID transactions |
| Auth | JWT (jsonwebtoken) + bcrypt | Stateless auth, secure password hashing |
| Future | Redis, Stripe, Socket.io, QR code | Phase B — seat locking, payments, real-time |

---

## 3. Database Schema

```mermaid
erDiagram
    CUSTOMERS {
        int customer_id PK
        string name
        string email UK
        string phone
        string password_hash
        string default_location
        timestamp created_at
    }

    ORGANIZERS {
        int org_id PK
        string org_name
        string email UK
        string phone
        string password_hash
        timestamp created_at
    }

    VENUES {
        int venue_id PK
        string venue_name
        string address
        string city
        int total_capacity
        json seat_layout_json
        timestamp created_at
    }

    EVENTS {
        int event_id PK
        int org_id FK
        int venue_id FK
        string event_name
        text description
        string category
        timestamp event_start_time
        timestamp event_end_time
        string status
        timestamp sale_window_start
        timestamp sale_window_end
        timestamp created_at
    }

    SEATS {
        int seat_id PK
        int event_id FK
        string section
        string row_label
        int seat_number
        decimal price
        string status
    }

    EVENT_SECTION_PRICING {
        int event_id FK
        string section
        decimal price
    }

    ORGANIZERS ||--o{ EVENTS : "creates"
    VENUES ||--o{ EVENTS : "hosts"
    EVENTS ||--o{ SEATS : "has"
    EVENTS ||--o{ EVENT_SECTION_PRICING : "prices"
```

### Key Design Decisions

1. **Separate `customers` and `organizers` tables** — different roles need different fields. No shared "users" table with a role column that could be spoofed.

2. **`seat_layout_json` is a TEMPLATE** — it lives on the venue and describes the structure (sections, rows, seats per row). Real seat rows are generated per event when published.

3. **Event lifecycle**: `draft → published → live → sold_out → closed`. Draft events are invisible to customers and have no seats.

4. **`event_section_pricing`** is the authoritative price record. Individual seat prices can be changed but this table tracks the "official" section price.

---

## 4. Backend Architecture

### Layered Architecture

```mermaid
flowchart LR
    REQ["HTTP Request"] --> ROUTE["Route\n(URL matching)"]
    ROUTE --> MW["Middleware\n(authenticate + requireRole)"]
    MW --> CTRL["Controller\n(validation + response)"]
    CTRL --> SVC["Service\n(business logic + SQL)"]
    SVC --> DB["PostgreSQL"]

    style REQ fill:#f1f5f9,stroke:#cbd5e1,color:#1e1b4b
    style MW fill:#f59e0b,stroke:#d97706,color:#fff
    style CTRL fill:#6366f1,stroke:#4f46e5,color:#fff
    style SVC fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style DB fill:#10b981,stroke:#059669,color:#fff
```

**Why 3 layers?**
- **Controller**: Validates HTTP input, sends HTTP responses. Knows about `req` and `res`.
- **Service**: Pure business logic. Knows about database queries. Does NOT know about `req`/`res`.
- **Middleware**: Cross-cutting concerns (auth, rate limiting, error handling).

This separation means the service layer is reusable (e.g., a CLI tool or cron job could call `createEvent()` without going through HTTP).

---

### 4.1 Authentication Flow

**How signup works (step by step):**

1. Customer fills the signup form (name, email, password, city)
2. Frontend sends `POST /api/auth/customer/signup`
3. Backend hashes the password with `bcrypt` (10 salt rounds)
4. Backend inserts the customer into the database
5. Backend creates a JWT token (expires in 7 days)
6. Returns `{ token, user }` → frontend saves to localStorage

```mermaid
flowchart TD
    A["1️⃣ Customer fills form\nname, email, password, city"]
    B["2️⃣ Frontend sends\nPOST /api/auth/customer/signup"]
    C["3️⃣ Backend hashes password\nbcrypt.hash - 10 salt rounds"]
    D["4️⃣ INSERT INTO customers\nname, email, password_hash, city_id"]
    E["5️⃣ Create JWT token\njwt.sign - id, role, 7 days expiry"]
    F["6️⃣ Return token + user info\nFrontend saves to localStorage"]
    G["7️⃣ Redirect to /events\nNavbar shows customer name"]

    A --> B --> C --> D --> E --> F --> G

    style C fill:#f59e0b,stroke:#d97706,color:#fff
    style E fill:#6366f1,stroke:#4f46e5,color:#fff
    style G fill:#10b981,stroke:#059669,color:#fff
```

**How login works:**

Same flow, but instead of hashing + inserting, the backend:
- Looks up the customer by email
- Compares the submitted password against the stored hash using `bcrypt.compare()`
- If match → creates JWT and returns it
- If no match → returns 401 "Invalid credentials"

**How protected routes work:**

```mermaid
flowchart LR
    A["Frontend sends request\nwith Authorization header"]
    B["Middleware: jwt.verify\nExtracts id + role"]
    C{"Valid\ntoken?"}
    D["req.user = id, role\nContinue to controller"]
    E["401 Unauthorized\nRequest rejected"]

    A --> B --> C
    C -- yes --> D
    C -- no --> E

    style D fill:#10b981,stroke:#059669,color:#fff
    style E fill:#ef4444,stroke:#dc2626,color:#fff
```

Every API request from the frontend includes `Authorization: Bearer <token>` in the header (added automatically by `api.js`). The middleware decodes the JWT and sets `req.user = { id, role }` so controllers know who is making the request.

---

### 4.2 Event Creation + Venue Conflict Check

**What happens when an organizer creates an event:**

```mermaid
flowchart TD
    A["1️⃣ Organizer selects venue\nand fills event details"]
    B["2️⃣ POST /api/events\nvenueId, name, startTime, endTime\nbufferBefore: 2h, bufferAfter: 2h"]
    C["3️⃣ Backend checks:\nDoes this venue exist?"]
    D{"4️⃣ Venue\nexists?"}
    E["❌ Error: Venue not found"]
    F["5️⃣ Calculate blocked window:\nstart - 2h to end + 2h"]
    G["6️⃣ Check for overlapping events\nat same venue in same window"]
    H{"7️⃣ Any\noverlap?"}
    I["❌ Error: Venue already booked!\nShows conflicting event name + times"]
    J["8️⃣ INSERT event as DRAFT\nNo seats generated yet"]
    K["✅ Return new event\nRedirect to manage page"]

    A --> B --> C --> D
    D -- no --> E
    D -- yes --> F --> G --> H
    H -- yes --> I
    H -- no --> J --> K

    style E fill:#ef4444,stroke:#dc2626,color:#fff
    style F fill:#f59e0b,stroke:#d97706,color:#fff
    style I fill:#ef4444,stroke:#dc2626,color:#fff
    style K fill:#10b981,stroke:#059669,color:#fff
```

**Buffer time example:**

| | Time |
|---|---|
| Buffer starts | 2:00 PM (2h before event) |
| **Event starts** | **4:00 PM** |
| **Event ends** | **10:00 PM** |
| Buffer ends | 12:00 AM midnight (2h after event) |
| **Venue blocked** | **2:00 PM → 12:00 AM** |

Any other event whose blocked window overlaps this range → **rejected**.

---

### 4.3 Event Publishing + Seat Generation

**What happens when an organizer clicks "Publish":**

```mermaid
flowchart TD
    A["1️⃣ Organizer sets prices\nper section: VIP=200, General=75"]
    B["2️⃣ POST /api/events/3/publish\nwith sectionPricing object"]
    C{"3️⃣ Is sale_window_start\nalready set?"}
    D["❌ Error: Set the sale window\nstart date before publishing"]
    E["4️⃣ Load venue's seat_layout_json\nSections → Rows → Seats per row"]
    F["5️⃣ Generate individual seats\nOne row per seat in the DB"]
    G["6️⃣ Example: VIP has rows A,B\nwith 10 seats each = 20 seats"]
    H["7️⃣ Save section pricing\nevent_section_pricing table"]
    I["8️⃣ Update event status\ndraft → published"]
    J["✅ Done! 50 seats created\nEvent now visible to customers"]

    A --> B --> C
    C -- no --> D
    C -- yes --> E --> F --> G --> H --> I --> J

    style D fill:#ef4444,stroke:#dc2626,color:#fff
    style F fill:#6366f1,stroke:#4f46e5,color:#fff
    style I fill:#f59e0b,stroke:#d97706,color:#fff
    style J fill:#10b981,stroke:#059669,color:#fff
```

**Seat generation detail:**

The venue's `seat_layout_json` looks like this:
```json
{
  "sections": [
    { "name": "VIP", "rows": ["A", "B"], "seats_per_row": 10, "default_price": 150 },
    { "name": "General", "rows": ["C", "D", "E"], "seats_per_row": 10, "default_price": 50 }
  ]
}
```

This generates **50 individual seat rows** in the `seats` table:

| seat_id | section | row | seat_number | price | status |
|---------|---------|-----|-------------|-------|--------|
| 1 | VIP | A | 1 | 200 | available |
| 2 | VIP | A | 2 | 200 | available |
| ... | ... | ... | ... | ... | ... |
| 20 | VIP | B | 10 | 200 | available |
| 21 | General | C | 1 | 75 | available |
| ... | ... | ... | ... | ... | ... |
| 50 | General | E | 10 | 75 | available |

Notice the prices (200, 75) come from the organizer's `sectionPricing` input, not the venue's `default_price`. If the organizer didn't set a price for a section, the venue's default is used as fallback.

---

### 4.4 Organizer Privacy (Dashboard)

**How we prevent organizers from seeing each other's events:**

```mermaid
flowchart TD
    A["Organizer A logs in\nJWT contains org_id = 1"]
    B["Dashboard loads\nGET /api/events?myEvents=true"]
    C["Backend extracts org_id\nfrom JWT token, NOT from URL"]
    D["SQL: WHERE e.org_id = 1"]
    E["✅ Returns only\nOrg A's events"]

    F["Organizer B logs in\nJWT contains org_id = 2"]
    G["Dashboard loads\nGET /api/events?myEvents=true"]
    H["SQL: WHERE e.org_id = 2"]
    I["✅ Returns only\nOrg B's events"]

    A --> B --> C --> D --> E
    F --> G --> H --> I

    style D fill:#ef4444,stroke:#dc2626,color:#fff
    style H fill:#ef4444,stroke:#dc2626,color:#fff
    style E fill:#10b981,stroke:#059669,color:#fff
    style I fill:#10b981,stroke:#059669,color:#fff
```

**Why this is secure:**

The `org_id` filter comes from the **JWT token** (set by the server when the organizer logged in), NOT from the query string. Even if Organizer A manually edited the URL to include `?orgId=2`, the backend ignores that and reads the org_id from the verified JWT instead. There's no way to spoof it without the server's JWT secret.

---

## 5. Frontend Architecture

### 5.1 Application Structure

```
frontend/app/
├── layout.js              ← Root layout (AuthProvider + Navbar wraps ALL pages)
├── globals.css            ← Design system (light theme, CSS variables)
├── page.js                ← Landing page (/)
├── lib/
│   └── api.js             ← HTTP client (auto-attaches JWT)
├── context/
│   └── AuthContext.js     ← Global auth state (login/logout/user)
├── components/
│   ├── Navbar.js          ← Dark gradient navbar, role-based links
│   └── EventCard.js       ← Reusable card for event listings
├── auth/
│   ├── login/page.js      ← Customer login
│   └── signup/page.js     ← Customer signup (with city dropdown)
├── organizer/
│   ├── login/page.js      ← Organizer login + signup (tab toggle)
│   ├── dashboard/page.js  ← My events only (privacy filtered)
│   ├── venues/
│   │   └── create/page.js ← Create venue with section builder
│   └── events/
│       ├── create/page.js ← Select venue + create event
│       └── [id]/page.js   ← Edit details + publish + inline pricing
└── events/
    ├── page.js            ← Browse published events (filter by city/category)
    └── [id]/page.js       ← Event detail page (customer view)
```

### 5.2 Auth State Management

```mermaid
flowchart TD
    A["User opens app"]
    B["AuthProvider checks localStorage"]
    C{"Token\nexists?"}
    D["Decode JWT payload"]
    E{"Token\nexpired?"}
    F["Set user = null\n(not logged in)"]
    G["Restore user state\nfrom localStorage"]
    H["Navbar renders based on role"]

    I["User clicks Login"]
    J["Submit email + password"]
    K["API returns {token, user}"]
    L["Save to localStorage\n+ update React state"]
    M["Redirect to dashboard/events"]

    N["User clicks Logout"]
    O["Clear localStorage\n+ set user = null"]
    P["Redirect to home"]

    A --> B --> C
    C -- no --> F --> H
    C -- yes --> D --> E
    E -- yes --> F
    E -- no --> G --> H

    I --> J --> K --> L --> M
    N --> O --> P

    style L fill:#6366f1,stroke:#4f46e5,color:#fff
    style O fill:#ef4444,stroke:#dc2626,color:#fff
```

### 5.3 Design System (CSS)

**Theme**: Light, warm, modern — inspired by Linear, Luma, and Vercel.

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-primary` | `#fafafa` | Page background |
| `--bg-surface` | `#ffffff` | Card surfaces |
| `--color-primary` | `#6366f1` | Indigo — buttons, links |
| `--color-accent` | `#f43f5e` | Rose — highlights |
| `--text-primary` | `#1e1b4b` | Headings, body text |
| `--text-secondary` | `#64748b` | Muted descriptions |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.06)` | Card shadows |

**Navbar**: Dark indigo gradient (`#1e1b4b → #312e81`) — contrasts against the light page.

---

## 6. API Reference

### Auth Endpoints

| Method | Endpoint | Body | Response | Auth |
|--------|----------|------|----------|------|
| POST | `/api/auth/customer/signup` | `{name, email, password}` | `{token, user}` | No |
| POST | `/api/auth/customer/login` | `{email, password}` | `{token, user}` | No |
| POST | `/api/auth/organizer/signup` | `{name, email, password}` | `{token, user}` | No |
| POST | `/api/auth/organizer/login` | `{email, password}` | `{token, user}` | No |

### Venue Endpoints

| Method | Endpoint | Body | Response | Auth |
|--------|----------|------|----------|------|
| POST | `/api/venues` | `{name, city, seatLayoutJson}` | venue object | Organizer |
| GET | `/api/venues` | — | array of venues | Any |
| GET | `/api/venues/:id` | — | single venue | Any |

### Event Endpoints

| Method | Endpoint | Body | Response | Auth |
|--------|----------|------|----------|------|
| POST | `/api/events` | `{venueId, name, startTime, endTime, bufferHoursBefore, bufferHoursAfter, ...}` | event object | Organizer |
| GET | `/api/events?myEvents=true` | — | organizer's events only | Organizer |
| GET | `/api/events?status=published` | — | published events | Any |
| GET | `/api/events/:eventId` | — | event + venue + pricing | Any |
| PATCH | `/api/events/:eventId` | `{name?, description?, saleWindowStart?, ...}` | updated event | Organizer |
| POST | `/api/events/:eventId/publish` | `{sectionPricing: {VIP:200}}` | `{seatsCreated}` | Organizer |
| PATCH | `/api/events/:eventId/pricing` | `{section, price}` | `{newPrice, seatsUpdated}` | Organizer |

---

## 7. Complete User Workflows

### 7.1 Organizer: From Signup to Published Event

```mermaid
flowchart TD
    A["1. Organizer signs up\n/organizer/login → Sign Up tab"]
    B["2. Gets JWT token\n→ stored in localStorage"]
    C["3. Lands on Dashboard\n(empty — no events yet)"]
    D["4. Clicks 'Create Event'"]
    E["5. Creates venue\n(or selects existing)"]
    F["6. Fills event details:\nname, dates, category,\nbuffer time (setup/teardown)"]
    G{"7. Venue time\nconflict?"}
    H["Error: venue booked!\nAdjust time or pick different venue"]
    I["8. Event created as DRAFT\n→ redirected to manage page"]
    J["9. Clicks Edit → sets\nSale Window Start/End"]
    K["10. Sets pricing per section:\nVIP=200, General=75"]
    L["11. Clicks 'Publish'\n→ 50 seats generated"]
    M["12. Event is PUBLISHED\n→ visible to customers"]
    N["13. Can update prices anytime\nvia inline Edit buttons"]

    A --> B --> C --> D --> E --> F --> G
    G -- yes --> H --> F
    G -- no --> I --> J --> K --> L --> M --> N

    style A fill:#ede9fe,stroke:#c4b5fd,color:#1e1b4b
    style G fill:#f59e0b,stroke:#d97706,color:#fff
    style L fill:#ef4444,stroke:#dc2626,color:#fff
    style M fill:#10b981,stroke:#059669,color:#fff
```

### 7.2 Customer: From Signup to Browsing Events

```mermaid
flowchart TD
    A["1. Customer signs up\n/auth/signup"]
    B["2. Gets JWT token"]
    C["3. Browses /events\n→ sees published events only"]
    D["4. Filters by category\nor searches by city"]
    E["5. Clicks an event card"]
    F["6. Event detail page:\nvenue info, dates, section prices"]
    G["7. Clicks 'Buy Tickets'\n(Phase B — not yet implemented)"]

    A --> B --> C --> D --> E --> F --> G

    style A fill:#ede9fe,stroke:#c4b5fd,color:#1e1b4b
    style F fill:#6366f1,stroke:#4f46e5,color:#fff
    style G fill:#f1f5f9,stroke:#cbd5e1,color:#1e1b4b
```

---

## 8. Security Measures

| Threat | Protection |
|--------|-----------|
| Password theft | bcrypt hashing (10 salt rounds) |
| Token forgery | JWT signed with server-side secret |
| Organizer impersonation | `org_id` comes from JWT, not request body |
| Cross-organizer data leak | `?myEvents=true` reads org_id from JWT, not query params |
| Venue double-booking | SQL overlap check with buffer hours |
| Price manipulation | Seat prices are set server-side, never from client |
| CORS attacks | Express CORS middleware configured |

---

## 9. File Structure

```
Event_Ticketing_System/
│
├── backend/
│   ├── server.js                    ← Entry point (Express app)
│   ├── .env                         ← Database URL, JWT secret
│   └── src/
│       ├── config/
│       │   ├── db.js                ← PostgreSQL connection pool
│       │   ├── redis.js             ← Redis client (Phase B)
│       │   └── stripe.js            ← Stripe config (Phase B)
│       ├── middleware/
│       │   ├── authMiddleware.js    ← JWT verify + role check
│       │   ├── errorHandler.js      ← Global error handler
│       │   └── rateLimiter.js       ← Rate limiting (Phase B)
│       ├── routes/
│       │   ├── authRoutes.js        ← /api/auth/*
│       │   ├── venueRoutes.js       ← /api/venues/*
│       │   ├── eventRoutes.js       ← /api/events/*
│       │   └── ... (Phase B routes)
│       ├── controllers/
│       │   ├── authController.js    ← Signup/login handlers
│       │   ├── venueController.js   ← CRUD venue handlers
│       │   ├── eventController.js   ← CRUD + publish + pricing
│       │   └── ... (Phase B controllers)
│       ├── service/
│       │   ├── authService.js       ← bcrypt + JWT logic
│       │   ├── venueService.js      ← Venue CRUD + capacity calc
│       │   ├── eventService.js      ← Event CRUD + conflict check
│       │   ├── seatService.js       ← Seat generation + pricing
│       │   └── ... (Phase B services)
│       └── models/
│           ├── customerModel.js     ← Schema docs
│           ├── organizerModel.js
│           ├── venueModel.js
│           ├── eventModel.js
│           ├── seatModel.js
│           └── ... (Phase B models)
│
├── frontend/
│   ├── app/
│   │   ├── layout.js               ← Root layout
│   │   ├── globals.css             ← Design system
│   │   ├── page.js                 ← Landing page
│   │   ├── lib/api.js              ← HTTP client
│   │   ├── context/AuthContext.js   ← Auth state
│   │   ├── components/             ← Navbar, EventCard
│   │   ├── auth/                   ← Login, Signup pages
│   │   ├── organizer/              ← Dashboard, Create, Manage
│   │   └── events/                 ← Browse, Detail pages
│   └── next.config.mjs
│
└── Explanation/
    ├── All_Services_Overview.md     ← Backend service documentation
    ├── Phase_A_Auth_Venue_Event_CRUD.md ← Phase A implementation details
    ├── Frontend_Build_Walkthrough.md    ← Frontend page-by-page guide
    └── Complete_Workflow.md         ← THIS FILE — full project overview
```

---

## 10. What's Built vs What's Coming

### ✅ Phase A — COMPLETED

| Feature | Status |
|---------|--------|
| Customer signup/login | ✅ Done |
| Organizer signup/login | ✅ Done |
| JWT authentication | ✅ Done |
| Venue creation with seat layout | ✅ Done |
| Shared venue visibility | ✅ Done |
| Event creation (draft) | ✅ Done |
| Venue time conflict detection | ✅ Done |
| Configurable buffer hours | ✅ Done |
| Event publishing + seat generation | ✅ Done |
| Sale window validation | ✅ Done |
| Per-section pricing (publish) | ✅ Done |
| Inline price editing (post-publish) | ✅ Done |
| Edit event details anytime | ✅ Done |
| Organizer privacy (my events only) | ✅ Done |
| Full frontend (16 pages) | ✅ Done |
| Light theme CSS redesign | ✅ Done |

### 🔜 Phase B — COMING NEXT

| Feature | What It Does |
|---------|-------------|
| Redis seat locking | Hold a seat for 5 min while customer checks out |
| Real-time seat map | WebSocket (Socket.io) — see seats lock/unlock live |
| Waiting room | Queue system when sales open (fairness) |
| Stripe payments | Secure checkout with webhooks |
| Order management | Order creation, status tracking |
| Ticket + QR code | Generate downloadable tickets with QR codes |
| My Tickets page | Customer can view/download their tickets |
| Super Admin dashboard | Manage organizers and venues centrally |

---

## 11. How to Run the Project

```bash
# 1. Start PostgreSQL (must be running)

# 2. Backend
cd backend
npm install
npm run dev          # starts on port 5000

# 3. Frontend
cd frontend
npm install
npm run dev          # starts on port 3000

# 4. Open browser
# http://localhost:3000
```

### Environment Variables (backend/.env)

```env
DATABASE_URL=postgresql://user:password@localhost:5432/event_ticketing
JWT_SECRET=your-secret-key
PORT=5000
```
