# Event Ticketing Platform — Complete Architecture Reference

This is a stage-by-stage trace of everything that happens from the moment a customer clicks an event to the moment they hold a confirmed ticket — every REST endpoint, every Redis command, every Lua script, and every SQL query, taken directly from the actual implementation.

---

## Glossary — new terms used throughout

| Term | Meaning |
|---|---|
| **Lua script** | A small script that Redis runs *inside itself*, atomically. Normally, if your code does "GET a value, decide something, then SET a new value," another request could sneak in between the GET and the SET (a race condition). A Lua script sent to Redis via `EVAL` runs as a single, uninterruptible unit — nothing else can run on that Redis instance while it executes. This is how we get "check 3 seats are all available, then lock all 3" to happen atomically, without needing a database transaction. |
| **TTL (Time To Live)** | A countdown Redis attaches to a key. When it hits zero, Redis deletes the key automatically — no code has to run. Used here for seat holds (10 min) and payment windows (5 min). |
| **Idempotent / Idempotency** | Calling the same operation twice has the same effect as calling it once. Needed because networks are unreliable — a payment confirmation request might get sent twice (e.g. a retry), and it must not create two tickets or charge twice. |
| **Two-phase commit** | Splitting a "commit this change" operation into two steps across two different systems (here: Redis and Postgres) so that either *both* succeed or *both* get rolled back — never a half-done state where one system thinks the seat is sold and the other doesn't. |
| **Optimistic vs pessimistic locking** | Pessimistic = block others out while you decide (e.g. Postgres `SELECT ... FOR UPDATE`). Optimistic = let everyone proceed, but check for conflicts right before the final write (e.g. a `version` column). This project uses **pessimistic locking at the database layer, for a very short window**, plus a **Redis atomic lock (via Lua)** as the fast, short-lived gatekeeper before that. |
| **WebSocket** | A persistent, two-way connection between browser and server (unlike normal HTTP, which is one request/one response then closed). Used here purely so every browser looking at the same seat map sees color changes live — it is NOT what prevents double-booking. |
| **Source of truth** | Whichever system's data is considered "the real answer" if two systems ever disagree. Here: **Redis is the source of truth during the live booking flow** (fast, temporary states). **PostgreSQL is the source of truth for anything permanent** (a seat that's actually sold, a ticket that actually exists). |

---

## Part 1 — The Redis seat state machine

Every seat has exactly one Redis key, and that key can only be in one of four states:

```
seat:{eventId}:{seatId}  →  AVAILABLE | HELD:{holdId} | FINALIZING:{holdId} | BOOKED
```

| State | Meaning | TTL |
|---|---|---|
| `AVAILABLE` | Free to select | none |
| `HELD:{holdId}` | A specific customer's session is holding it while they decide/checkout | 600s (10 min) |
| `FINALIZING:{holdId}` | Payment succeeded, the Postgres write is in progress right now | **none — deliberately** |
| `BOOKED` | Permanently sold | none — persists forever |

**Why `FINALIZING` has no TTL, when `HELD` does:** `HELD` needs to expire automatically if a customer abandons the flow — that's the whole point of a TTL. But `FINALIZING` only exists for the few hundred milliseconds it takes to run the Postgres transaction. If it had a TTL and somehow expired mid-transaction, the seat could look "available" again to someone else while your database write is still in flight — a race condition. So `FINALIZING` is set with a plain `SET` (no `EX` flag), guaranteeing it can only be moved by explicit code (either "commit to BOOKED" or "roll back to AVAILABLE"), never by a timer.

---

## Part 2 — The five Lua scripts (the actual concurrency-safety mechanism)

These are stored as JavaScript template strings in `redisInventoryService.js` and executed with `redis.eval(script, numKeys, ...keys, ...args)`.

### ACQUIRE_SEATS — locking seats when a customer selects them

```lua
local holdValue = ARGV[1]
local ttl = tonumber(ARGV[2])

-- Phase 1: Verify ALL seats are AVAILABLE
for i = 1, #KEYS do
  local val = redis.call('GET', KEYS[i])
  if val ~= 'AVAILABLE' and val ~= false then
    return 0
  end
end

-- Phase 2: All available → acquire all atomically
for i = 1, #KEYS do
  redis.call('SET', KEYS[i], holdValue, 'EX', ttl)
end

return 1
```
`KEYS` = the list of `seat:{eventId}:{seatId}` keys being requested. `val == false` means the key doesn't exist yet (never initialized, or its previous TTL expired) — treated the same as `AVAILABLE`.

**Why this needs to be one atomic script and not two separate Redis calls:** if you did "check all seats are available" as one call and "lock them" as a second call, another customer's request could slip in between those two calls and grab one of the same seats. Wrapping both phases in a single Lua script means Redis executes the whole thing as one indivisible operation — no other command can run on that Redis instance in between.

**Called from:** `acquireSeats(eventId, seatIds, holdId, ttl)` in `redisInventoryService.js`, which is called from `POST /booking-sessions/:sessionId/seats/:seatId`.

### RELEASE_SEAT — deselecting a single seat

```lua
local val = redis.call('GET', KEYS[1])
if val == ARGV[1] then
  redis.call('SET', KEYS[1], 'AVAILABLE')
  return 1
end
return 0
```
Only releases the seat if it's still held by *this* customer's `holdId` — prevents accidentally releasing a seat someone else has since acquired.

### RELEASE_SEATS — releasing a whole hold at once (on abandonment or payment failure)

```lua
local expected = ARGV[1]
local released = 0
for i = 1, #KEYS do
  local val = redis.call('GET', KEYS[i])
  if val == expected then
    redis.call('SET', KEYS[i], 'AVAILABLE')
    released = released + 1
  end
end
return released
```

### FINALIZE_SEATS — the critical HELD → FINALIZING transition, right after payment succeeds

```lua
local expectedHeld = ARGV[1]
local finalizeValue = ARGV[2]

-- Phase 1: Verify ALL seats belong to this holdId
for i = 1, #KEYS do
  local val = redis.call('GET', KEYS[i])
  if val ~= expectedHeld then
    return 0
  end
end

-- Phase 2: Transition all to FINALIZING (no TTL)
for i = 1, #KEYS do
  redis.call('SET', KEYS[i], finalizeValue)
end

return 1
```
If even one seat's hold expired or was somehow taken by someone else in the meantime, this returns `0` and **nothing** gets finalized — all-or-nothing, same principle as `ACQUIRE_SEATS`.

### ROLLBACK_FINALIZE — undoing a finalize if the Postgres write then fails

```lua
local expected = ARGV[1]
local rolledBack = 0
for i = 1, #KEYS do
  local val = redis.call('GET', KEYS[i])
  if val == expected then
    redis.call('SET', KEYS[i], 'AVAILABLE')
    rolledBack = rolledBack + 1
  end
end
return rolledBack
```

---

## Part 3 — Every REST endpoint, grouped by stage

### Stage A — Browsing

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/events` | List events (filterable by category, city) |
| `GET` | `/api/events/:eventId` | Single event detail page |

### Stage B — Waiting room (`waitingRoomRoutes.js`, mounted at `/api/events/:eventId/waiting-room`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/join` | Try to get admitted, or get queued |
| `GET` | `/position` | Poll current queue position |
| `POST` | `/release` | Explicitly free this customer's admitted slot |

### Stage C — Seat selection (`bookingSessionRoutes.js`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/events/:eventId/booking-sessions` | Start a selection session (checks event is on sale) |
| `POST` | `/api/booking-sessions/:sessionId/seats/:seatId` | Select (acquire) one seat |
| `DELETE` | `/api/booking-sessions/:sessionId/seats/:seatId` | Deselect one seat |
| `POST` | `/api/booking-sessions/:sessionId/proceed` | Lock in selection, start the 5-min payment timer |
| `GET` | `/api/booking-sessions/:sessionId` | Poll session status / remaining TTL |
| `DELETE` | `/api/booking-sessions/:sessionId` | Cancel the whole session, release all held seats |

### Stage D — Checkout & payment (`orderRoutes.js`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/orders` | Create a `pending` order + a Razorpay order |
| `POST` | `/api/orders/:orderId/pay` | Verify Razorpay signature → finalize the booking |
| `GET` | `/api/orders/:orderId` | Fetch order/ticket details |
| `POST` | `/api/orders/:orderId/cancel` | Explicit cancel (timer expired / user backed out) |
| `POST` | `/api/orders/:orderId/cancel-beacon` | Same as `/cancel`, but callable from `navigator.sendBeacon()` on tab close (token passed in body since beacon requests can't set headers) |

---

## Part 4 — Full walkthrough, stage by stage, with exact code

### Stage 1 — Customer clicks an event

```
GET /api/events/:eventId
```
Plain Postgres read — event details, venue, pricing. No Redis involved yet.

### Stage 2 — Customer clicks "Buy Tickets" → waiting room check

```
POST /api/events/:eventId/waiting-room/join
```

Backend logic (`waitingRoomService.tryAdmit`):
```javascript
async function tryAdmit(eventId, customerId) {
  await sweepExpired(eventId);
  // ZREMRANGEBYSCORE admitted:{eventId} -inf now()
  // ↑ removes anyone whose 10-min window already passed, before counting

  const existingScore = await redis.zscore(`admitted:${eventId}`, customerStr);
  if (existingScore !== null && Number(existingScore) > Date.now()) {
    return { admitted: true };   // already admitted, still valid
  }

  const admittedCount = await redis.zcard(`admitted:${eventId}`);
  const threshold = await getThreshold(eventId);

  if (admittedCount < threshold) {
    const expiresAt = Date.now() + (ADMITTED_TTL * 1000);
    await redis.zadd(`admitted:${eventId}`, expiresAt, customerStr);
    return { admitted: true };
  }

  // No room — join the FIFO queue
  await redis.zadd(`waiting_room:${eventId}`, Date.now(), customerStr);
  const position = await redis.zrank(`waiting_room:${eventId}`, customerStr);
  return { admitted: false, position: position + 1, totalInQueue };
}
```

**Redis data structure used:** a **Sorted Set** (`ZADD`/`ZSCORE`/`ZCARD`/`ZRANK`), not a plain Set. The score doubles as the expiry timestamp for `admitted:{eventId}`, and as the join-time for FIFO ordering in `waiting_room:{eventId}`. This is what makes admitted slots **self-cleaning** — `ZREMRANGEBYSCORE` sweeps out anyone whose time has passed as a side effect of every count check, so a slot can never leak permanently the way a plain Set + separate TTL key would.

### Stage 3 — Seat selection begins: create a booking session

```
POST /api/events/:eventId/booking-sessions
```

1. Postgres check: is the event `published`/`live`, and are we inside `sale_window_start`–`sale_window_end`?
2. `bookingSessionService.createSession(userId, eventId)`:
```javascript
const sessionId = `S${uuid}`;
const holdId = `H${uuid}`;   // this is what Redis seat keys will reference

await redis.set(
  `session:${sessionId}`,
  JSON.stringify({ sessionId, holdId, userId, eventId, selectedSeats: [], expiresAt }),
  'EX',
  600   // 10 minutes
);
```
Note: **`holdId` is separate from `sessionId`.** `sessionId` identifies the browser session; `holdId` is the literal value written into every `seat:{eventId}:{seatId}` key (`HELD:{holdId}`). Keeping them separate means the Lua scripts only ever need to compare one string, not reach back into session JSON.

### Stage 4 — Customer clicks a seat

```
POST /api/booking-sessions/:sessionId/seats/:seatId
```

1. `validateSession(sessionId, userId)` — reads `session:{sessionId}` from Redis, confirms it exists and belongs to this user.
2. Reads the session's **remaining** TTL and passes it into `acquireSeats(...)` — so the seat's hold expires at exactly the same moment the session does, never later.
3. Calls `ACQUIRE_SEATS` Lua script (shown above) via `redis.eval(...)`.
4. On success (`result === 1`): adds the seat to `session.selectedSeats`, responds `200`, then fires `broadcastSeatUpdate(eventId, 'SEAT_HELD', seatId)` over WebSocket — **after** responding to the caller, so the person who clicked doesn't wait on it.
5. On failure (`result === 0`): responds `409 Conflict` — this is exactly the "User A already grabbed this seat" case.

### Stage 5 — Proceed to payment

```
POST /api/booking-sessions/:sessionId/proceed
```

1. Re-validates session.
2. **Re-verifies every selected seat still shows `HELD:{holdId}` in Redis right now** (`getSeatMap`) — protects against the hold quietly expiring between selection and this click.
3. Reads seat prices from Postgres (frozen at this moment — later price changes by the organizer won't affect this checkout).
4. Creates a **second, independent timer**:
```javascript
await redis.set(
  `payment_timer:${sessionId}`,
  JSON.stringify({ sessionId, holdId, userId, eventId, seatIds }),
  'EX',
  300   // 5 minutes — separate from the 10-min selection timer
);
```
Two separate timers exist on purpose: 10 minutes to *decide* which seats, then a fresh 5 minutes to actually *pay* — so a slow checkout page doesn't eat into decision time and vice versa.

### Stage 6 — Order creation

```
POST /api/orders
Body: { sessionId, holdId, eventId, seatIds }
```

`orderService.createOrder(...)`:
```sql
INSERT INTO orders (customer_id, event_id, status, total_amount, idempotency_key)
VALUES ($1, $2, 'pending', $3, $4)
RETURNING order_id;

-- for each seat:
INSERT INTO order_items (order_id, seat_id, price_at_purchase)
VALUES ($1, $2, $3);
```
Then stores a metadata snapshot in Redis (`order_meta:{orderId}`, 10-min TTL) — this is what `confirmOrder` reads later instead of trusting anything the frontend sends back, closing off tampering.

Then calls Razorpay's API to create a matching Razorpay order, and returns `razorpayOrderId` + `razorpayKeyId` to the frontend, which opens Razorpay's checkout modal.

### Stage 7 — Payment completes → the critical finalization

```
POST /api/orders/:orderId/pay
Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
```

**Step 1 — verify the signature** (`paymentService.verifyPayment`): recomputes an HMAC-SHA256 over `razorpay_order_id|razorpay_payment_id` using your Razorpay secret key, compares it to the signature Razorpay sent. If it doesn't match, the payment claim is rejected outright — this is what stops someone from just calling this endpoint directly with a fake "success."

**Step 2 — `confirmOrder(orderId, userId)`** in `orderService.js`, the core of the whole system:

```javascript
// 0. Idempotency — if already confirmed, return the existing booking
if (existingOrder.status === 'confirmed') return getConfirmedOrderDetails(orderId);

// 1. Read order metadata from Redis (not from the client)
const meta = JSON.parse(await redis.get(`order_meta:${orderId}`));

// 2. Payment timer must still be alive
const paymentTimer = await redis.get(`payment_timer:${meta.sessionId}`);
if (!paymentTimer) { /* release seats, mark order expired, throw */ }

// 3. Lua: HELD → FINALIZING (atomic, all seats)
const finalizeResult = await finalizeSeats(meta.eventId, meta.seatIds, meta.holdId);
if (!finalizeResult.success) { /* mark order failed, throw */ }

// 4. SHORT Postgres transaction — this is the only place a DB transaction
//    is held open, and only for milliseconds, never during payment itself
const client = await pool.connect();
await client.query('BEGIN');

const lockResult = await client.query(
  `SELECT seat_id, status, version FROM seats
   WHERE seat_id = ANY($1) AND event_id = $2 FOR UPDATE`,
  [meta.seatIds, meta.eventId]
);
// FOR UPDATE = pessimistic row lock, held only until COMMIT/ROLLBACK below

const allAvailable = lockResult.rows.every(s => s.status === 'available');
if (!allAvailable) {
  await client.query('ROLLBACK');
  await rollbackFinalize(meta.eventId, meta.seatIds, meta.holdId); // Lua: undo
  throw new Error('Seats no longer available in database');
}

await client.query(
  `UPDATE seats SET status = 'booked', version = version + 1
   WHERE seat_id = ANY($1) AND event_id = $2 AND status = 'available'`,
  [meta.seatIds, meta.eventId]
);
await client.query(`UPDATE orders SET status = 'confirmed' WHERE order_id = $1`, [orderId]);

for (const seatId of meta.seatIds) {
  const qrCode = await generateQRCode(JSON.stringify({ orderId, seatId, eventId, ts: Date.now() }));
  await client.query(
    `INSERT INTO tickets (order_id, seat_id, price, qr_code)
     VALUES ($1, $2, (SELECT price FROM seats WHERE seat_id = $2), $3)`,
    [orderId, seatId, qrCode]
  );
}

await client.query('COMMIT');
client.release();

// 5. Redis: FINALIZING → BOOKED, no TTL, permanent
await confirmSeats(meta.eventId, meta.seatIds);

// 6. Broadcast to every connected viewer
broadcastMultiSeatUpdate(meta.eventId, 'SEAT_BOOKED', meta.seatIds);

// 7. Cleanup
await redis.del(`order_meta:${orderId}`);
await redis.del(`payment_timer:${meta.sessionId}`);
```

**Why this order of operations matters (this is the part worth explaining carefully in an interview):**
- The Postgres transaction is opened **only after** the Lua finalize succeeds, and closed within milliseconds — it never spans the actual payment gateway call, which could take seconds and would otherwise hold a database lock open dangerously long.
- `FOR UPDATE` inside that short transaction is a **second, independent check** — even though Redis already confirmed the hold was valid, Postgres re-verifies `status = 'available'` itself before writing. If Redis and Postgres ever disagreed (e.g. a bug, a Redis failure), Postgres — the permanent source of truth — is what actually gets the final word.
- Every failure branch does **both** roll-backs: Postgres `ROLLBACK` **and** the Lua `rollbackFinalize` (Redis `FINALIZING` → `AVAILABLE`). Skipping either would leave the two systems disagreeing about the seat's state.

**Step 3 — record the payment:**
```sql
INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
VALUES ($1, 'razorpay', $2, $3, 'succeeded')
ON CONFLICT DO NOTHING;
```
`ON CONFLICT DO NOTHING` is another idempotency guard — if this webhook/callback fires twice, the second insert is a silent no-op instead of a duplicate row or a crash.

**Step 4 — release the waiting room slot:**
```
releaseSlot(eventId, userId)  → ZREM admitted:{eventId} userId, then admit next in queue
```

### Stage 8 — Confirmation page

```
GET /api/orders/:orderId
```
Joins `orders` → `tickets` → `seats` in Postgres and returns everything, including each ticket's QR code, for the confirmation page / "My Tickets."

---

## Part 5 — Real-time layer (WebSocket) — and why it's not part of the safety guarantee

```
ws://localhost:5000/ws?eventId={eventId}
```

`ws/seatBroadcast.js` keeps an in-memory `Map<eventId, Set<WebSocket>>` of connected clients per event. On any seat state change, the server sends:
```json
{ "type": "SEAT_HELD" | "SEAT_AVAILABLE" | "SEAT_BOOKED", "seatId": 42, "timestamp": 1234567890 }
```
to everyone currently viewing that event's seat map.

**This is explicitly documented in the code as UI-only:** *"Even if a client misses a WebSocket update, the backend always validates against Redis before allowing acquisition."* In other words — if your WebSocket message never arrives, or arrives late, the worst that happens is a seat looks green on your screen for a moment when it's actually taken. The moment you try to click it, the real `ACQUIRE_SEATS` Lua check runs against Redis and correctly rejects you. **The WebSocket layer can fail completely and the system still cannot oversell a seat** — that guarantee lives entirely in Redis + Postgres, not in the socket layer. This distinction is one of the most important things to be able to explain clearly in an interview: real-time updates for *experience*, atomic operations for *correctness* — two separate concerns, solved by two separate mechanisms.

---

## Part 6 — Failure / abandonment paths

| Scenario | What releases the seat/slot |
|---|---|
| Selection timer (10 min) expires, never proceeded | `session:{sessionId}` Redis key expires → seat's own `HELD` TTL (same duration) also expires independently. Nothing extra needed — both were set with matching TTLs. |
| Reaches payment page, closes tab | `DELETE /booking-sessions/:sessionId` (called by frontend on "back" or timeout) → `releaseSeats` Lua + `releaseSlot` |
| Tab closed without any warning (`beforeunload`) | `POST /orders/:orderId/cancel-beacon` via `navigator.sendBeacon()` — works even as the page is unloading, since beacon requests are guaranteed to be sent |
| Payment timer (5 min) expires before paying | Detected inside `confirmOrder` (`payment_timer` missing) → releases seats, marks order `expired` |
| Invalid Razorpay signature | `failOrder()` + `releaseSlot()` |
| Any exception during `confirmOrder` | `failOrder()` + `releaseSlot()` (generic catch-all in the route handler) |

---

## Part 7 — Database schema (PostgreSQL) touched during booking

```sql
-- seats: the permanent source of truth
seat_id, event_id, section, row_label, seat_number, price,
status ('available' | 'booked'), version   -- version bumped on every booking write

-- orders
order_id, customer_id, event_id, status
  ('pending' | 'confirmed' | 'failed' | 'expired'),
total_amount, idempotency_key

-- order_items: frozen per-seat price at the moment of order creation
order_id, seat_id, price_at_purchase

-- tickets: one row per booked seat, generated only on confirmed payment
ticket_id, order_id, seat_id, price, qr_code

-- payments
payment_id, order_id, provider, provider_payment_id, amount, status
```

---

## One-paragraph summary you can say out loud in an interview

*"Redis is the fast, temporary source of truth during the live booking flow — every seat is a single key that moves through AVAILABLE → HELD → FINALIZING → BOOKED, and every multi-seat transition is done with a Lua script so the check-and-lock happens as one atomic operation, closing the race condition you'd get from doing a GET then a SET as two separate calls. PostgreSQL is the permanent source of truth — it only gets touched in one short transaction, right after payment succeeds, using SELECT FOR UPDATE as a second independent check before anything is written permanently. If that Postgres write fails for any reason, both Redis and Postgres are rolled back together, so the two systems can never disagree about whether a seat is sold. WebSockets sit completely outside this — they're only there so people watching the same seat map see live color changes; the actual guarantee against double-booking would hold even if every WebSocket connection in the system dropped."* 