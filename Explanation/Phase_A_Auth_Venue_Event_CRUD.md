# Phase A — Auth, Venue CRUD, Event CRUD

## What Was Built

This phase built the **foundation layer** — the three pieces that everything else in the system depends on. Without these, you can't create venues, create events, or know who is making a request.

---

## 1. Authentication System

### What it does
Handles user registration and login for **two separate user types**: customers and organizers.

### How it works — Step by step

```mermaid
flowchart TD
    A["User hits POST /api/auth/customer/signup\nBody: { name, email, password }"]
    B["authController.customerSignup()\nValidates: name, email, password present?"]
    C["authService.signupCustomer()\nStep 1: bcrypt.hash(password, 10)"]
    D["Step 2: INSERT INTO customers\n(name, email, password_hash)"]
    E{"Email already\nexists?"}
    F["409 Conflict:\n'Account with this email exists'"]
    G["Step 3: jwt.sign({ id, role: 'customer' })"]
    H["201 Created:\n{ token, user: { id, name, email, role } }"]

    A --> B --> C --> D --> E
    E -- Yes --> F
    E -- No --> G --> H

    style A fill:#1a1a2e,stroke:#e94560,color:#fff
    style C fill:#533483,stroke:#e94560,color:#fff
    style G fill:#0f3460,stroke:#16213e,color:#fff
    style H fill:#2d6a4f,stroke:#1b4332,color:#fff
```

### Login Flow

```mermaid
flowchart TD
    A["User hits POST /api/auth/customer/login\nBody: { email, password }"]
    B["authController.customerLogin()"]
    C["authService.loginCustomer()\nStep 1: SELECT FROM customers WHERE email = ?"]
    D{"Customer\nfound?"}
    E["Step 2: bcrypt.compare(password, hash)"]
    F{"Password\nmatches?"}
    G["401: 'Invalid email or password'\n(same message for both cases\nto prevent user enumeration)"]
    H["Step 3: jwt.sign({ id, role: 'customer' })"]
    I["200 OK: { token, user }"]

    A --> B --> C --> D
    D -- No --> G
    D -- Yes --> E --> F
    F -- No --> G
    F -- Yes --> H --> I

    style G fill:#e94560,stroke:#16213e,color:#fff
    style I fill:#2d6a4f,stroke:#1b4332,color:#fff
```

### JWT Middleware — How Protected Routes Work

Once a user has a token, every subsequent API request includes it in the header:
```
Authorization: Bearer eyJhbGciOiJI...
```

```mermaid
flowchart TD
    A["Request arrives at a protected route\ne.g. POST /api/venues"]
    B["authenticate middleware runs"]
    C{"Authorization\nheader present?"}
    D["401: 'Authentication required'"]
    E["jwt.verify(token, JWT_SECRET)"]
    F{"Token valid\nand not expired?"}
    G["401: 'Invalid/expired token'"]
    H["req.user = { id, role }"]
    I["requireRole('organizer') runs"]
    J{"req.user.role\n=== 'organizer'?"}
    K["403: 'Access denied.\nRequired role: organizer'"]
    L["✅ Controller handles the request"]

    A --> B --> C
    C -- No --> D
    C -- Yes --> E --> F
    F -- No --> G
    F -- Yes --> H --> I --> J
    J -- No --> K
    J -- Yes --> L

    style D fill:#e94560,stroke:#16213e,color:#fff
    style G fill:#e94560,stroke:#16213e,color:#fff
    style K fill:#e94560,stroke:#16213e,color:#fff
    style L fill:#2d6a4f,stroke:#1b4332,color:#fff
```

### Files involved

| File | Purpose |
|------|---------|
| `src/services/authService.js` | Business logic: password hashing (bcrypt), token generation (JWT), database queries |
| `src/controllers/authController.js` | HTTP layer: validates request body, calls service, sends response with proper status codes |
| `src/middleware/authMiddleware.js` | JWT verification (`authenticate`) and role enforcement (`requireRole`) |
| `src/routes/authRoutes.js` | Maps URLs to controller functions |

### API Endpoints

| Method | URL | Auth Required | Body | Response |
|--------|-----|---------------|------|----------|
| POST | `/api/auth/customer/signup` | No | `{ name, email, password, phone?, defaultLocation? }` | `{ token, user }` |
| POST | `/api/auth/customer/login` | No | `{ email, password }` | `{ token, user }` |
| POST | `/api/auth/organizer/signup` | No | `{ name, email, password, phone? }` | `{ token, user }` |
| POST | `/api/auth/organizer/login` | No | `{ email, password }` | `{ token, user }` |

---

## 2. Venue CRUD

### What it does
Organizers can create venues (physical buildings with seating layouts), and anyone can view them.

### Flow — Creating a Venue

```mermaid
flowchart TD
    A["Organizer hits POST /api/venues\nHeaders: Authorization: Bearer {token}\nBody: { name, seatLayoutJson, ... }"]
    B["authenticate middleware\n→ verifies JWT, sets req.user"]
    C["requireRole('organizer')\n→ checks req.user.role"]
    D["venueController.createVenueHandler()\nValidates: name present?\nseatLayoutJson has sections array?\neach section has name, rows, seats_per_row?"]
    E["venueService.createVenue()\nAuto-calculates total_capacity\nfrom sections if not provided"]
    F["INSERT INTO venues\n(name, address, city, capacity, seat_layout_json)"]
    G["201 Created: venue object"]

    A --> B --> C --> D --> E --> F --> G

    style A fill:#1a1a2e,stroke:#e94560,color:#fff
    style D fill:#533483,stroke:#e94560,color:#fff
    style G fill:#2d6a4f,stroke:#1b4332,color:#fff
```

### Files involved

| File | Purpose |
|------|---------|
| `src/services/venueService.js` | Create, list, get venues. Auto-calculates capacity from layout. |
| `src/controllers/venueController.js` | Validates seat layout structure before passing to service. |
| `src/routes/venueRoutes.js` | POST (organizer only), GET list, GET by ID (any authenticated user). |

### API Endpoints

| Method | URL | Auth | Role | Body / Params |
|--------|-----|------|------|---------------|
| POST | `/api/venues` | Yes | Organizer | `{ name, address?, city?, seatLayoutJson }` |
| GET | `/api/venues` | Yes | Any | — |
| GET | `/api/venues/:venueId` | Yes | Any | — |

---

## 3. Event CRUD

### What it does
Organizers can create events (as drafts), and anyone can list/view them.

### The Complete Event Lifecycle (now fully connected)

```mermaid
flowchart TD
    A["1️⃣ POST /api/auth/organizer/signup\n→ Get JWT token"]
    B["2️⃣ POST /api/venues\n→ Create venue with seat layout\n(needs organizer token)"]
    C["3️⃣ POST /api/events\n→ Create event as 'draft'\n(needs organizer token + venue ID)"]
    D["4️⃣ POST /api/events/:id/publish\n→ Generate seats + pricing\n(needs organizer token)"]
    E["5️⃣ PATCH /api/events/:id/pricing\n→ Change section price\n(optional, anytime after publish)"]
    F["6️⃣ GET /api/events\n→ Customers browse published events"]
    G["7️⃣ GET /api/events/:id\n→ Customer views event details\n+ section pricing"]

    A --> B --> C --> D
    D --> E
    D --> F --> G

    style A fill:#1a1a2e,stroke:#0f3460,color:#fff
    style B fill:#1a1a2e,stroke:#0f3460,color:#fff
    style C fill:#1a1a2e,stroke:#0f3460,color:#fff
    style D fill:#533483,stroke:#e94560,color:#fff
    style E fill:#533483,stroke:#e94560,color:#fff
    style F fill:#0f3460,stroke:#16213e,color:#fff
    style G fill:#0f3460,stroke:#16213e,color:#fff
```

### Flow — Creating an Event

```mermaid
flowchart TD
    A["Organizer hits POST /api/events\nBody: { venueId, name, startTime, endTime, ... }"]
    B["authenticate + requireRole('organizer')"]
    C["eventController.createEventHandler()\nValidates: venueId, name, startTime, endTime\nChecks endTime > startTime"]
    D["eventService.createEvent()\nVerifies venue exists\nSets orgId from req.user.id (JWT)"]
    E["INSERT INTO events\nstatus = 'draft'"]
    F["201 Created: event object\n(status: 'draft', no seats yet)"]

    A --> B --> C --> D --> E --> F

    style F fill:#2d6a4f,stroke:#1b4332,color:#fff
```

### Files involved

| File | Purpose |
|------|---------|
| `src/services/eventService.js` | Create, list (with filters), get by ID (with venue + pricing JOIN). |
| `src/controllers/eventController.js` | All 5 handlers: create, list, get, publish, updatePricing. |
| `src/routes/eventRoutes.js` | Full routing with auth middleware per endpoint. |

### API Endpoints

| Method | URL | Auth | Role | Body / Query |
|--------|-----|------|------|-------------|
| POST | `/api/events` | Yes | Organizer | `{ venueId, name, startTime, endTime, ... }` |
| GET | `/api/events` | Yes | Any | `?status=published&city=Bangalore&category=Music` |
| GET | `/api/events/:eventId` | Yes | Any | — |
| POST | `/api/events/:eventId/publish` | Yes | Organizer | `{ sectionPricing?: { "VIP": 200 } }` |
| PATCH | `/api/events/:eventId/pricing` | Yes | Organizer | `{ section: "VIP", price: 170 }` |

---

## 4. Updated server.js

The entry point now mounts all three route groups:

```
/api/auth    → authRoutes.js    (signup/login)
/api/venues  → venueRoutes.js   (venue CRUD)
/api/events  → eventRoutes.js   (event CRUD + publish + pricing)
```

### How a request flows through the entire stack

```mermaid
flowchart LR
    A["HTTP Request"] --> B["server.js\n(Express app)"]
    B --> C["CORS middleware"]
    C --> D["JSON parser"]
    D --> E{"URL prefix?"}
    E -- "/api/auth" --> F["authRoutes.js"]
    E -- "/api/venues" --> G["venueRoutes.js"]
    E -- "/api/events" --> H["eventRoutes.js"]
    F --> I["authController"]
    G --> J["venueController"]
    H --> K["eventController"]
    I --> L["authService"]
    J --> M["venueService"]
    K --> N["eventService\nseatService"]
    L --> O["PostgreSQL"]
    M --> O
    N --> O

    style A fill:#1a1a2e,stroke:#e94560,color:#fff
    style O fill:#0f3460,stroke:#16213e,color:#fff
```

---

## What's Next

Now that the foundation is complete, the next phase builds the **core booking engine**:

| # | What | Description |
|---|------|-------------|
| 1 | Redis config | Connect to Upstash Redis |
| 2 | Seat locking | `SET seat:{id} NX EX 300` — the concurrency mechanism |
| 3 | Waiting room | Threshold-based queue with Redis sorted sets |
| 4 | Orders + Stripe | Checkout flow, price freeze in order_items, webhook |
| 5 | WebSocket | Live seat map + waiting room position updates |
| 6 | Frontend | Next.js pages for all customer and organizer flows |
