# Frontend Build — Complete Walkthrough (Updated)

## What Was Built

The frontend connects to all 4 existing backend services (Auth, Venue, Event, Seat). Here's every page, what it does, and which API endpoint it calls.

---

## Architecture Overview

```mermaid
flowchart TD
    subgraph "Frontend (Next.js — port 3000)"
        LAYOUT["layout.js\n(AuthProvider + Navbar)"]
        API["lib/api.js\n(fetch wrapper + JWT)"]
        AUTH_CTX["context/AuthContext.js\n(user state management)"]

        subgraph "Pages"
            HOME["/ — Landing"]
            LOGIN["auth/login — Customer Login"]
            SIGNUP["auth/signup — Customer Signup"]
            ORG_LOGIN["organizer/login — Organizer Auth"]
            EVENTS["events/ — Browse Events"]
            EVENT_DETAIL["events/[id] — Event Detail"]
            DASH["organizer/dashboard — My Events ONLY"]
            CREATE["organizer/events/create — Create Event"]
            MANAGE["organizer/events/[id] — Manage Event"]
        end
    end

    subgraph "Backend (Express — port 5000)"
        AUTH_API["/api/auth/*"]
        VENUE_API["/api/venues/*"]
        EVENT_API["/api/events/*"]
    end

    LAYOUT --> AUTH_CTX
    LAYOUT --> API
    LOGIN --> AUTH_API
    SIGNUP --> AUTH_API
    ORG_LOGIN --> AUTH_API
    EVENTS --> EVENT_API
    EVENT_DETAIL --> EVENT_API
    DASH --> EVENT_API
    CREATE --> VENUE_API
    CREATE --> EVENT_API
    MANAGE --> EVENT_API

    style AUTH_API fill:#6366f1,stroke:#4f46e5,color:#fff
    style VENUE_API fill:#6366f1,stroke:#4f46e5,color:#fff
    style EVENT_API fill:#6366f1,stroke:#4f46e5,color:#fff
```

---

## Shared Foundation

### 1. api.js — API Client

Every component uses this instead of calling `fetch()` directly.

```mermaid
flowchart LR
    A["Component calls\napi.get('/events')"] --> B["api.js builds headers:\nContent-Type: application/json\nAuthorization: Bearer {token}"]
    B --> C["fetch('http://localhost:5000/api/events')"]
    C --> D{"Response OK?"}
    D -- Yes --> E["Return parsed JSON"]
    D -- No --> F["Throw Error with\nserver's error message"]

    style B fill:#6366f1,stroke:#4f46e5,color:#fff
```

### 2. AuthContext.js — Auth State

```mermaid
flowchart TD
    A["App loads"]
    B["AuthProvider mounts"]
    C{"Token in\nlocalStorage?"}
    D["Decode JWT → check exp"]
    E{"Token\nexpired?"}
    F["Clear localStorage\nuser = null"]
    G["Restore user from\nlocalStorage\nuser = { id, name, role }"]
    H["loading = false\nApp renders"]

    A --> B --> C
    C -- No --> F --> H
    C -- Yes --> D --> E
    E -- Yes --> F
    E -- No --> G --> H

    style G fill:#10b981,stroke:#059669,color:#fff
```

### 3. Navbar.js — Role-Based Navigation

```mermaid
flowchart TD
    A["Navbar reads useAuth()"]
    B{"user is\nnull?"}
    C["Show: Browse Events, Login, Sign Up"]
    D{"user.role?"}
    E["Customer:\nEvents, My Tickets, Name, Logout"]
    F["Organizer:\nDashboard, Create Event, Name, Logout"]

    A --> B
    B -- Yes --> C
    B -- No --> D
    D -- customer --> E
    D -- organizer --> F

    style C fill:#f1f5f9,stroke:#cbd5e1,color:#1e1b4b
    style E fill:#ede9fe,stroke:#c4b5fd,color:#1e1b4b
    style F fill:#fce7f3,stroke:#f9a8d4,color:#1e1b4b
```

---

## Page-by-Page Flow

### Customer Login → /auth/login

```mermaid
flowchart TD
    A["User types email + password"]
    B["Submit → api.post('/auth/customer/login')"]
    C["Backend: bcrypt.compare → jwt.sign"]
    D["Response: { token, user }"]
    E["AuthContext.login(token, user)\n→ saves to localStorage\n→ updates React state"]
    F["router.push('/events')\n→ Navbar re-renders with user name"]

    A --> B --> C --> D --> E --> F

    style E fill:#6366f1,stroke:#4f46e5,color:#fff
    style F fill:#10b981,stroke:#059669,color:#fff
```

### Browse Events → /events

```mermaid
flowchart TD
    A["Page mounts"]
    B["useEffect: api.get('/events?status=published')"]
    C["Backend: SELECT events JOIN venues\nWHERE status='published'"]
    D["Response: array of event objects"]
    E["Render EventCard grid"]
    F["User clicks category filter\nor types city"]
    G["useEffect re-fires with new params"]

    A --> B --> C --> D --> E
    F --> G --> B

    style E fill:#10b981,stroke:#059669,color:#fff
```

### Create Event → /organizer/events/create

```mermaid
flowchart TD
    A["Organizer fills form"]
    B{"Venue mode?"}
    C["'select' → pick from dropdown"]
    D["'create' → fill venue form\nwith section builder"]
    E["Submit"]
    F["api.post('/venues', seatLayoutJson)\n→ creates venue → gets venue_id"]
    G["api.post('/events', { venueId, name,\nbufferHoursBefore, bufferHoursAfter, ... })"]
    H{"Venue time\nconflict?"}
    I["Error: Venue is already booked!\nChoose different time or venue"]
    J["Event created as 'draft'\n→ router.push to manage page"]

    A --> B
    B -- select --> C --> E
    B -- create --> D --> E
    E -- new venue --> F --> G
    E -- existing --> G
    G --> H
    H -- yes --> I
    H -- no --> J

    style F fill:#6366f1,stroke:#4f46e5,color:#fff
    style G fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style I fill:#ef4444,stroke:#dc2626,color:#fff
    style J fill:#10b981,stroke:#059669,color:#fff
```

### Manage Event → /organizer/events/[id] (UPDATED)

```mermaid
flowchart TD
    A["Page loads → api.get('/events/{id}')"]
    B["Shows Event Details card\nwith Edit button"]
    C["Organizer clicks Edit"]
    D["All fields become editable:\nname, description, category,\nstart/end time, sale window"]
    E["Organizer saves\n→ api.patch('/events/{id}')"]

    F{{"Event status?"}}
    G["DRAFT → Show publish section\nwith per-section pricing fields"]
    H["PUBLISHED → Show section pricing\nwith inline Edit buttons"]

    I{"Sale window\nstart set?"}
    J["Error: Set sale window\nstart before publishing"]
    K["Organizer clicks 'Publish'\n→ api.post('/events/{id}/publish')"]
    L["seatService generates seats\n→ status becomes 'published'"]

    M["Organizer clicks Edit Price\nnext to a section"]
    N["Inline input appears\n→ enter new price → Save"]
    O["api.patch('/events/{id}/pricing')\n→ updates unsold seats"]

    A --> B --> F
    B --> C --> D --> E --> A

    F -- draft --> G --> I
    I -- no --> J --> C
    I -- yes --> K --> L --> A

    F -- published --> H --> M --> N --> O --> A

    style E fill:#6366f1,stroke:#4f46e5,color:#fff
    style J fill:#f59e0b,stroke:#d97706,color:#fff
    style K fill:#ef4444,stroke:#dc2626,color:#fff
    style O fill:#8b5cf6,stroke:#7c3aed,color:#fff
```

### Organizer Dashboard → /organizer/dashboard (PRIVACY FIX)

```mermaid
flowchart TD
    A["Dashboard loads"]
    B["api.get('/events?myEvents=true')"]
    C["Backend reads JWT → extracts org_id"]
    D["SQL: WHERE e.org_id = JWT.id"]
    E["Returns ONLY this organizer's events"]
    F["Render stats + events table"]

    A --> B --> C --> D --> E --> F

    style D fill:#ef4444,stroke:#dc2626,color:#fff
    style F fill:#10b981,stroke:#059669,color:#fff
```

---

## All Pages Summary

| Page | URL | API Calls | Auth Required | Role |
|------|-----|-----------|---------------|------|
| Landing | `/` | None | No | — |
| Customer Login | `/auth/login` | `POST /auth/customer/login` | No | — |
| Customer Signup | `/auth/signup` | `POST /auth/customer/signup` | No | — |
| Organizer Login | `/organizer/login` | `POST /auth/organizer/login` or `/signup` | No | — |
| Browse Events | `/events` | `GET /events?status=published` | Yes | Any |
| Event Detail | `/events/[id]` | `GET /events/:id` | Yes | Any |
| Dashboard | `/organizer/dashboard` | `GET /events?myEvents=true` | Yes | Organizer |
| Create Event | `/organizer/events/create` | `GET /venues`, `POST /venues`, `POST /events` | Yes | Organizer |
| Manage Event | `/organizer/events/[id]` | `GET /events/:id`, `PATCH /events/:id`, `POST .../publish`, `PATCH .../pricing` | Yes | Organizer |
| Seat Map | `/events/[id]/seats` | — (Phase B) | — | — |
| Waiting Room | `/events/[id]/waiting-room` | — (Phase B) | — | — |
| Checkout | `/checkout` | — (Phase B) | — | — |
| My Tickets | `/my-tickets` | — (Phase B) | — | — |
| Confirmation | `/confirmation/[orderId]` | — (Phase B) | — | — |

---

## Recent Changes (Latest)

### 1. Organizer Privacy
- Dashboard now calls `?myEvents=true` → backend filters by JWT org_id
- Organizer A cannot see Organizer B's events

### 2. Venue Time Conflict
- `createEvent()` checks for overlapping events at the same venue
- Configurable buffer hours (before/after) for setup/teardown
- Create event form has "Venue Buffer Time" section

### 3. Edit Event Details
- New `PATCH /api/events/:eventId` endpoint
- Manage page has Edit toggle → all fields become input fields
- Sale window can be set/updated anytime

### 4. Per-Section Pricing Fields
- Publish form reads venue's `seat_layout_json` sections
- Shows individual price input for each section (not a text string)

### 5. Inline Price Editing
- After publishing, each section shows an "Edit Price" button
- Click → inline input appears → Save → updates unsold seats

### 6. Sale Window Required for Publish
- Frontend + backend both validate `sale_window_start` before allowing publish
- Clear error message tells organizer to use Edit to set it

### 7. CSS Redesign
- Light theme: white cards, soft shadows, indigo accents
- Dark navy navbar for contrast
- Status badges with pastel backgrounds

---

## Files Created / Modified

| File | What It Does |
|------|-------------|
| `app/lib/api.js` | Fetch wrapper with auto JWT headers |
| `app/context/AuthContext.js` | React context for login/logout/user state |
| `app/globals.css` | Light theme design system (v2) |
| `app/layout.js` | Root layout with AuthProvider + Navbar |
| `app/components/Navbar.js` | Dark nav bar with role-based links |
| `app/components/EventCard.js` | Reusable event card for listings |
| `app/page.js` | Landing page with gradient hero |
| `app/auth/login/page.js` | Customer login form |
| `app/auth/signup/page.js` | Customer signup form |
| `app/organizer/login/page.js` | Organizer login+signup with tab toggle |
| `app/events/page.js` | Event listing with category/city filters |
| `app/events/[id]/page.js` | Event detail with pricing sidebar |
| `app/organizer/dashboard/page.js` | Privacy-filtered events table |
| `app/organizer/events/create/page.js` | Venue + event + buffer time form |
| `app/organizer/events/[id]/page.js` | Edit details + publish + inline pricing |
| 5 placeholder pages | Phase B features (seats, checkout, etc.) |
