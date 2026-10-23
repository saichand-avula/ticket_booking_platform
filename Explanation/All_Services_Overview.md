# All Services — Complete Overview & Workflow

## Summary

There are **10 service files** in `backend/src/services/`. **4 are built** with working code, **6 are empty placeholders** for future phases.

| # | Service File | Status | Purpose |
|---|-------------|--------|---------|
| 1 | `authService.js` | ✅ Built | Signup & login for customers and organizers |
| 2 | `venueService.js` | ✅ Built | Create, list, and get venues |
| 3 | `eventService.js` | ✅ Built | Create, list, and get events |
| 4 | `seatService.js` | ✅ Built | Generate seats at publish + update section price |
| 5 | `orderService.js` | 📭 Empty | Will handle order creation, price freeze in order_items |
| 6 | `paymentService.js` | 📭 Empty | Will handle Stripe PaymentIntent creation |
| 7 | `waitingRoomService.js` | 📭 Empty | Will handle Redis sorted-set queue logic |
| 8 | `ticketService.js` | 📭 Empty | Will handle ticket generation + QR codes |
| 9 | `redisService.js` | 📭 Empty | Will handle Redis connection + seat locking |
| 10 | `qrCodeService.js` | 📭 Empty | Will handle QR code image generation |

---

## How Services Fit Into The Architecture

Every request flows through the same layered pattern:

```
HTTP Request
    │
    ▼
server.js (mounts routes under URL prefixes)
    │
    ▼
routes/*.js (maps URL + HTTP method → controller function)
    │
    ▼
middleware (authenticate JWT, check role)
    │
    ▼
controllers/*.js (validates input, calls service, sends HTTP response)
    │
    ▼
services/*.js ← THIS LAYER (business logic, database queries, transactions)
    │
    ▼
PostgreSQL / Redis
```

**Why this separation?**
- **Routes** only know about URLs — "POST /api/events goes to createEventHandler"
- **Controllers** only know about HTTP — req, res, status codes, JSON
- **Services** only know about business logic — SQL queries, data transformations, transactions
- This means the same service function can be reused from a controller, a WebSocket handler, a CLI script, or a test — it doesn't care about HTTP

---

## Service 1: authService.js

### What it does
Handles user registration and login. Two user types (customers, organizers) in separate database tables.

### Functions

| Function | Input | What it does | Output |
|----------|-------|-------------|--------|
| `signupCustomer()` | name, email, phone, password, defaultLocation | Hash password → INSERT customer → generate JWT | `{ token, user }` |
| `signupOrganizer()` | name, email, phone, password | Hash password → INSERT organizer → generate JWT | `{ token, user }` |
| `loginCustomer()` | email, password | SELECT customer → compare hash → generate JWT | `{ token, user }` |
| `loginOrganizer()` | email, password | SELECT organizer → compare hash → generate JWT | `{ token, user }` |

### Workflow — Signup

```mermaid
flowchart TD
    A["signupCustomer(name, email, password, ...)"]
    B["bcrypt.hash(password, 10)\n→ produces a random-salted hash\n→ 'abc123' becomes '$2b$10$...'"]
    C["INSERT INTO customers\n(name, email, password_hash)\nRETURNING customer_id, customer_name, ..."]
    D{"Postgres\nUNIQUE violation?"}
    E["Throws: email already exists"]
    F["jwt.sign(\n  { id: customer_id, role: 'customer' },\n  JWT_SECRET,\n  { expiresIn: '7d' }\n)"]
    G["Returns: { token, user: { id, name, email, role } }"]

    A --> B --> C --> D
    D -- Yes --> E
    D -- No --> F --> G

    style B fill:#533483,stroke:#e94560,color:#fff
    style F fill:#0f3460,stroke:#16213e,color:#fff
    style G fill:#2d6a4f,stroke:#1b4332,color:#fff
```

### Workflow — Login

```mermaid
flowchart TD
    A["loginCustomer(email, password)"]
    B["SELECT customer_id, customer_name,\ncustomer_email, password_hash\nFROM customers\nWHERE customer_email = email"]
    C{"Row\nfound?"}
    D["Throws: 'Invalid email or password'\n(generic — prevents user enumeration)"]
    E["bcrypt.compare(password, stored_hash)\n→ re-hashes input with same salt\n→ checks if hashes match"]
    F{"Match?"}
    G["jwt.sign({ id, role: 'customer' })"]
    H["Returns: { token, user }"]

    A --> B --> C
    C -- No --> D
    C -- Yes --> E --> F
    F -- No --> D
    F -- Yes --> G --> H

    style D fill:#e94560,stroke:#16213e,color:#fff
    style E fill:#533483,stroke:#e94560,color:#fff
    style H fill:#2d6a4f,stroke:#1b4332,color:#fff
```

### Key Design Decisions
- **Separate tables** for customers and organizers (different fields, different roles)
- **bcrypt** for hashing (adaptive cost, random salt per hash)
- **JWT** with role embedded (no DB lookup needed on every request)
- **Same error message** for wrong email and wrong password (prevents enumeration attacks)

---

## Service 2: venueService.js

### What it does
Manages venues — physical buildings with seating layouts. A venue is created once and reused across many events.

### Functions

| Function | Input | What it does | Output |
|----------|-------|-------------|--------|
| `createVenue()` | name, address, city, totalCapacity, seatLayoutJson | Auto-calculate capacity → INSERT venue | venue object |
| `getAllVenues()` | — | SELECT all venues (newest first) | array of venues |
| `getVenueById()` | venueId | SELECT single venue | venue object |

### Workflow — Create Venue

```mermaid
flowchart TD
    A["createVenue({ name, seatLayoutJson, ... })"]
    B{"totalCapacity\nprovided?"}
    C["Use provided capacity"]
    D["Auto-calculate from layout:\nsum of (rows.length × seats_per_row)\nfor each section"]
    E["INSERT INTO venues\n(venue_name, address, city, total_capacity, seat_layout_json)\nRETURNING *"]
    F["Returns: venue object\nwith venue_id, auto-calculated capacity"]

    A --> B
    B -- Yes --> C --> E
    B -- No --> D --> E
    E --> F

    style D fill:#533483,stroke:#e94560,color:#fff
    style F fill:#2d6a4f,stroke:#1b4332,color:#fff
```

### The seat_layout_json Template

This is the blueprint stored in the venue. It defines the STRUCTURE only (not actual seats):

```json
{
  "sections": [
    {
      "name": "VIP",
      "rows": ["A", "B"],
      "seats_per_row": 10,
      "default_price": 100
    },
    {
      "name": "General",
      "rows": ["C", "D", "E"],
      "seats_per_row": 20,
      "default_price": 50
    }
  ]
}
```

**This template is NOT actual seats.** It's just a description: "this venue has a VIP section with rows A-B, 10 seats per row." Real seat rows in the `seats` table are generated later by `seatService.js` when an event is published at this venue.

---

## Service 3: eventService.js

### What it does
Manages events — concerts, sports matches, conferences, etc. An event starts as a `draft` and goes through a lifecycle.

### Functions

| Function | Input | What it does | Output |
|----------|-------|-------------|--------|
| `createEvent()` | orgId, venueId, name, times, ... | Verify venue exists → INSERT event as 'draft' | event object |
| `getAllEvents()` | filters (status, city, category, orgId) | Dynamic WHERE clause → SELECT with venue JOIN | array of events |
| `getEventById()` | eventId | SELECT event + venue + organizer JOIN, fetch section pricing | event object with pricing |

### Workflow — Create Event

```mermaid
flowchart TD
    A["createEvent({ orgId, venueId, name, startTime, endTime, ... })"]
    B["SELECT venue_id FROM venues\nWHERE venue_id = venueId"]
    C{"Venue\nexists?"}
    D["Throws: 'Venue does not exist.\nCreate the venue first.'"]
    E["INSERT INTO events\n(org_id, venue_id, event_name, ...\nstatus defaults to 'draft')"]
    F["Returns: event object\n(status = 'draft', no seats yet)"]

    A --> B --> C
    C -- No --> D
    C -- Yes --> E --> F

    style D fill:#e94560,stroke:#16213e,color:#fff
    style F fill:#2d6a4f,stroke:#1b4332,color:#fff
```

### Workflow — List Events (with Dynamic Filters)

```mermaid
flowchart TD
    A["getAllEvents({ status: 'published', city: 'Bangalore' })"]
    B["Start with: WHERE 1=1\n(always true — simplifies AND chaining)"]
    C{"status\nprovided?"}
    D["Add: AND e.status = 'published'"]
    E{"city\nprovided?"}
    F["Add: AND v.city ILIKE '%Bangalore%'"]
    G{"category\nprovided?"}
    H["Add: AND e.category ILIKE '%...'"]
    I["SELECT events JOIN venues\nWHERE {built conditions}\nORDER BY event_start_time ASC"]
    J["Returns: array of events\nwith venue_name and city"]

    A --> B --> C
    C -- Yes --> D --> E
    C -- No --> E
    E -- Yes --> F --> G
    E -- No --> G
    G -- Yes --> H --> I
    G -- No --> I
    I --> J

    style B fill:#533483,stroke:#e94560,color:#fff
    style J fill:#2d6a4f,stroke:#1b4332,color:#fff
```

### Workflow — Get Event by ID

```mermaid
flowchart TD
    A["getEventById(eventId)"]
    B["SELECT from events\nJOIN venues (name, address, city, capacity)\nJOIN organizers (org_name)\nWHERE event_id = eventId"]
    C{"Event\nfound?"}
    D["Throws: 'Event not found'"]
    E{"Status is\nnot 'draft'?"}
    F["Skip pricing query\n(drafts have no pricing yet)"]
    G["SELECT section, price\nFROM event_section_pricing\nWHERE event_id = eventId\nORDER BY price DESC"]
    H["Returns: event object\nwith venue info + organizer name\n+ sectionPricing array"]

    A --> B --> C
    C -- No --> D
    C -- Yes --> E
    E -- No (draft) --> F --> H
    E -- Yes --> G --> H

    style G fill:#533483,stroke:#e94560,color:#fff
    style H fill:#2d6a4f,stroke:#1b4332,color:#fff
```

---

## Service 4: seatService.js

### What it does
The most complex service. Handles two critical operations:
1. **Seat generation** — turning a venue template into real seat rows when an event is published
2. **Price updates** — changing a section's price mid-sale without affecting existing orders

### Functions

| Function | Input | What it does | Output |
|----------|-------|-------------|--------|
| `generateSeatsForEvent()` | eventId, sectionPricing? | Resolve prices → bulk INSERT seats → INSERT pricing → publish event | `{ seatsCreated }` |
| `updateSectionPrice()` | eventId, section, newPrice | UPDATE pricing table → bulk UPDATE unsold seats | `{ sectionUpdated, newPrice, seatsUpdated }` |

### Workflow — Generate Seats (at Publish Time)

```mermaid
flowchart TD
    A["generateSeatsForEvent(eventId, { VIP: 200, General: 75 })"]
    B["BEGIN TRANSACTION\n(all-or-nothing — partial failure\nrolls back everything)"]
    C["SELECT seat_layout_json\nFROM events JOIN venues\nWHERE event_id = eventId"]
    D["Resolve price for each section:\n• VIP → ₹200 (organizer supplied)\n• General → ₹75 (organizer supplied)\n• If organizer skipped → use default_price\n• If no default either → ERROR"]
    E["Flatten into seat list:\nVIP-A-1 (₹200), VIP-A-2 (₹200), ...\nGen-C-1 (₹75), Gen-C-2 (₹75), ..."]
    F["Bulk INSERT INTO seats\n(event_id, section, row_label, seat_number, price)\nAll 80 seats in ONE query"]
    G["INSERT INTO event_section_pricing\n(event_id='1', section='VIP', price=200)\n(event_id='1', section='General', price=75)"]
    H["UPDATE events\nSET status = 'published'"]
    I["COMMIT TRANSACTION"]
    J["Returns: { seatsCreated: 80 }"]

    A --> B --> C --> D --> E --> F --> G --> H --> I --> J

    style B fill:#e94560,stroke:#16213e,color:#fff
    style D fill:#533483,stroke:#e94560,color:#fff
    style F fill:#0f3460,stroke:#16213e,color:#fff
    style G fill:#0f3460,stroke:#16213e,color:#fff
    style I fill:#2d6a4f,stroke:#1b4332,color:#fff
```

### Price Resolution Priority

When generating seats, each section's price is resolved in this order:

```mermaid
flowchart TD
    A["Section: 'VIP'"]
    B{"Organizer supplied\nprice for VIP?"}
    C["Use organizer's price\n(sectionPricing.VIP)"]
    D{"Venue template has\ndefault_price for VIP?"}
    E["Use venue's default_price"]
    F{"Old format:\ntemplate has 'price'?"}
    G["Use old 'price' field\n(backward compatibility)"]
    H["ERROR: No price found\nfor this section"]

    A --> B
    B -- Yes --> C
    B -- No --> D
    D -- Yes --> E
    D -- No --> F
    F -- Yes --> G
    F -- No --> H

    style C fill:#2d6a4f,stroke:#1b4332,color:#fff
    style E fill:#0f3460,stroke:#16213e,color:#fff
    style G fill:#533483,stroke:#e94560,color:#fff
    style H fill:#e94560,stroke:#16213e,color:#fff
```

### Workflow — Update Section Price (Mid-Sale)

```mermaid
flowchart TD
    A["updateSectionPrice(eventId=1, section='VIP', newPrice=250)"]
    B["BEGIN TRANSACTION"]
    C["UPDATE event_section_pricing\nSET price = 250\nWHERE event_id=1 AND section='VIP'"]
    D{"Rows\nupdated?"}
    E["Throws: 'No pricing record found.\nWrong section name or\nevent not published yet.'"]
    F["UPDATE seats SET price = 250\nWHERE event_id=1\nAND section='VIP'\nAND status != 'sold'"]
    G["COMMIT"]
    H["Returns:\n{ sectionUpdated: 'VIP',\n  newPrice: 250,\n  seatsUpdated: 15 }"]

    A --> B --> C --> D
    D -- 0 rows --> E
    D -- 1 row --> F --> G --> H

    style C fill:#533483,stroke:#e94560,color:#fff
    style F fill:#0f3460,stroke:#16213e,color:#fff
    style H fill:#2d6a4f,stroke:#1b4332,color:#fff
```

### What Gets Updated vs What Stays Frozen

```mermaid
flowchart LR
    subgraph "Price Changes Affect"
        A["event_section_pricing\n(authoritative current price)"]
        B["seats WHERE status != 'sold'\n(live seat map display)"]
    end

    subgraph "Price Changes Do NOT Affect"
        C["seats WHERE status = 'sold'\n(historical — already purchased)"]
        D["order_items\n(price frozen at checkout start)"]
        E["tickets\n(price copied from order_items,\nnot from seats)"]
    end

    style A fill:#e94560,stroke:#16213e,color:#fff
    style B fill:#e94560,stroke:#16213e,color:#fff
    style C fill:#2d6a4f,stroke:#1b4332,color:#fff
    style D fill:#2d6a4f,stroke:#1b4332,color:#fff
    style E fill:#2d6a4f,stroke:#1b4332,color:#fff
```

---

## Services 5-10: Not Built Yet (Placeholders)

These will be built in the next phases:

| Service | What It Will Do | When It's Needed |
|---------|----------------|------------------|
| `redisService.js` | Connect to Upstash Redis, provide helper functions for SET/GET/DEL with TTL | Phase B — seat locking |
| `waitingRoomService.js` | Manage the Redis sorted-set queue: add to queue, check position, admit next user | Phase B — waiting room |
| `orderService.js` | Create order + order_items (freeze price), update order status from webhook | Phase B — checkout |
| `paymentService.js` | Create Stripe PaymentIntent, verify webhook signatures | Phase B — payments |
| `ticketService.js` | Generate ticket records after payment confirmation, link to order_items price | Phase B — tickets |
| `qrCodeService.js` | Generate QR code images for each ticket (for check-in scanning) | Phase B — tickets |

---

## Full Service Dependency Map

```mermaid
flowchart TD
    subgraph "Phase A — Built ✅"
        AUTH["authService.js"]
        VENUE["venueService.js"]
        EVENT["eventService.js"]
        SEAT["seatService.js"]
    end

    subgraph "Phase B — Not built yet"
        REDIS["redisService.js"]
        WAIT["waitingRoomService.js"]
        ORDER["orderService.js"]
        PAY["paymentService.js"]
        TICKET["ticketService.js"]
        QR["qrCodeService.js"]
    end

    subgraph "Data Stores"
        PG["PostgreSQL"]
        RD["Redis"]
        STRIPE["Stripe API"]
    end

    AUTH --> PG
    VENUE --> PG
    EVENT --> PG
    SEAT --> PG

    REDIS --> RD
    WAIT --> REDIS
    ORDER --> PG
    ORDER --> REDIS
    PAY --> STRIPE
    PAY --> PG
    TICKET --> PG
    TICKET --> QR

    style AUTH fill:#2d6a4f,stroke:#1b4332,color:#fff
    style VENUE fill:#2d6a4f,stroke:#1b4332,color:#fff
    style EVENT fill:#2d6a4f,stroke:#1b4332,color:#fff
    style SEAT fill:#2d6a4f,stroke:#1b4332,color:#fff
    style REDIS fill:#1a1a2e,stroke:#e94560,color:#fff
    style WAIT fill:#1a1a2e,stroke:#e94560,color:#fff
    style ORDER fill:#1a1a2e,stroke:#e94560,color:#fff
    style PAY fill:#1a1a2e,stroke:#e94560,color:#fff
    style TICKET fill:#1a1a2e,stroke:#e94560,color:#fff
    style QR fill:#1a1a2e,stroke:#e94560,color:#fff
    style PG fill:#0f3460,stroke:#16213e,color:#fff
    style RD fill:#0f3460,stroke:#16213e,color:#fff
    style STRIPE fill:#0f3460,stroke:#16213e,color:#fff
```
