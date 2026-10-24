# Event Ticketing Platform — Complete Architecture & Design Decisions Reference

This document has two halves. **Part A** is the stage-by-stage technical trace (what happens, in what order, with what code). **Part B** is organized entirely around *why* — every major decision paired with the alternatives that were considered and rejected, with a concrete example of how each alternative would have failed. Read Part A once to understand the system; use Part B to prepare for "why didn't you just do X instead?" — which is how most interviewers actually probe a project like this.

---

# PART A — Glossary & Technical Trace

## Glossary — new terms used throughout

| Term | Meaning |
|---|---|
| **Lua script** | A small script Redis runs *inside itself*, atomically — nothing else can execute on that Redis instance while it runs. Used here so "check 3 seats are available, then lock all 3" happens as one indivisible step. |
| **TTL (Time To Live)** | A countdown Redis attaches to a key. At zero, Redis deletes it automatically — no application code has to run. |
| **Idempotent / Idempotency** | Calling the same operation twice has the same effect as calling it once. Needed because networks are unreliable — a payment confirmation might be sent twice. |
| **Two-phase commit** | Splitting a "commit this" operation into two steps across two systems (Redis, Postgres) so either *both* succeed or *both* roll back — never a state where the two disagree. |
| **Pessimistic locking** | Block other requests out *before* you decide (e.g. Postgres `SELECT ... FOR UPDATE`). |
| **Optimistic locking** | Let everyone proceed, but check for conflicts *right before* the final write (e.g. a `version` column, `WHERE version = ?`). |
| **Distributed lock** | A lock that isn't tied to a single database transaction — implemented in a separate system (here, Redis) so it can be held across multiple steps/round-trips without pinning open a database connection. |
| **WebSocket** | A persistent two-way connection (unlike normal HTTP). Used purely for live UI updates — not part of the correctness guarantee. |
| **Source of truth** | Whichever system's data is considered "the real answer" if two systems disagree. Redis is the source of truth *during* the live flow (fast, temporary). Postgres is the source of truth for *permanent* facts. |
| **Race condition** | A bug that only happens when two things run at nearly the same time, in an unlucky order. The entire point of this architecture is closing race conditions around seat selection. |

## The Redis seat state machine

```
seat:{eventId}:{seatId}  →  AVAILABLE | HELD:{holdId} | FINALIZING:{holdId} | BOOKED
```

| State | Meaning | TTL |
|---|---|---|
| `AVAILABLE` | Free to select | none |
| `HELD:{holdId}` | One customer's session is holding it | 600s (10 min) |
| `FINALIZING:{holdId}` | Payment succeeded, Postgres write in progress | **none — deliberately** |
| `BOOKED` | Permanently sold | none — persists forever |

## The five Lua scripts

**ACQUIRE_SEATS** — locking seats on selection (all-or-nothing):
```lua
local holdValue = ARGV[1]
local ttl = tonumber(ARGV[2])
for i = 1, #KEYS do
  local val = redis.call('GET', KEYS[i])
  if val ~= 'AVAILABLE' and val ~= false then return 0 end
end
for i = 1, #KEYS do
  redis.call('SET', KEYS[i], holdValue, 'EX', ttl)
end
return 1
```

**RELEASE_SEAT** — deselecting one seat, only if still owned by this hold:
```lua
local val = redis.call('GET', KEYS[1])
if val == ARGV[1] then redis.call('SET', KEYS[1], 'AVAILABLE') return 1 end
return 0
```

**RELEASE_SEATS** — releasing a whole hold at once:
```lua
local expected = ARGV[1]
local released = 0
for i = 1, #KEYS do
  local val = redis.call('GET', KEYS[i])
  if val == expected then redis.call('SET', KEYS[i], 'AVAILABLE') released = released + 1 end
end
return released
```

**FINALIZE_SEATS** — HELD → FINALIZING, right after payment succeeds:
```lua
local expectedHeld = ARGV[1]
local finalizeValue = ARGV[2]
for i = 1, #KEYS do
  local val = redis.call('GET', KEYS[i])
  if val ~= expectedHeld then return 0 end
end
for i = 1, #KEYS do redis.call('SET', KEYS[i], finalizeValue) end
return 1
```

**ROLLBACK_FINALIZE** — undoing a finalize if Postgres then fails:
```lua
local expected = ARGV[1]
local rolledBack = 0
for i = 1, #KEYS do
  local val = redis.call('GET', KEYS[i])
  if val == expected then redis.call('SET', KEYS[i], 'AVAILABLE') rolledBack = rolledBack + 1 end
end
return rolledBack
```

## Every REST endpoint

| Stage | Method | Path | Purpose |
|---|---|---|---|
| Browse | `GET` | `/api/events` / `/api/events/:eventId` | List / detail |
| Waiting room | `POST` | `/api/events/:eventId/waiting-room/join` | Admit or queue |
| Waiting room | `GET` | `/api/events/:eventId/waiting-room/position` | Poll position |
| Waiting room | `POST` | `/api/events/:eventId/waiting-room/release` | Free the slot |
| Selection | `POST` | `/api/events/:eventId/booking-sessions` | Start session |
| Selection | `POST` | `/api/booking-sessions/:sessionId/seats/:seatId` | Select seat |
| Selection | `DELETE` | `/api/booking-sessions/:sessionId/seats/:seatId` | Deselect seat |
| Selection | `POST` | `/api/booking-sessions/:sessionId/proceed` | Start payment timer |
| Selection | `GET` / `DELETE` | `/api/booking-sessions/:sessionId` | Poll / cancel |
| Payment | `POST` | `/api/orders` | Create order + Razorpay order |
| Payment | `POST` | `/api/orders/:orderId/pay` | Verify + finalize |
| Payment | `GET` | `/api/orders/:orderId` | Fetch confirmation |
| Payment | `POST` | `/api/orders/:orderId/cancel` | Explicit cancel |
| Payment | `POST` | `/api/orders/:orderId/cancel-beacon` | Cancel on tab close |

## The finalization sequence (the core of the system)

```javascript
// 0. Idempotency check
if (order.status === 'confirmed') return getConfirmedOrderDetails(orderId);

// 1. Read metadata from Redis (never trust the client)
const meta = JSON.parse(await redis.get(`order_meta:${orderId}`));

// 2. Payment timer must still be alive
const paymentTimer = await redis.get(`payment_timer:${meta.sessionId}`);
if (!paymentTimer) { /* release, expire, throw */ }

// 3. Lua: HELD → FINALIZING (atomic)
const finalizeResult = await finalizeSeats(meta.eventId, meta.seatIds, meta.holdId);
if (!finalizeResult.success) { /* mark failed, throw */ }

// 4. SHORT Postgres transaction — only place a DB transaction is held open
await client.query('BEGIN');
const lockResult = await client.query(
  `SELECT seat_id, status, version FROM seats
   WHERE seat_id = ANY($1) AND event_id = $2 FOR UPDATE`, [meta.seatIds, meta.eventId]
);
const allAvailable = lockResult.rows.every(s => s.status === 'available');
if (!allAvailable) {
  await client.query('ROLLBACK');
  await rollbackFinalize(meta.eventId, meta.seatIds, meta.holdId);
  throw new Error('Seats no longer available');
}
await client.query(`UPDATE seats SET status='booked', version=version+1 WHERE ...`);
await client.query(`UPDATE orders SET status='confirmed' WHERE order_id=$1`, [orderId]);
// insert tickets + QR codes...
await client.query('COMMIT');

// 5. Redis: FINALIZING → BOOKED, no TTL
await confirmSeats(meta.eventId, meta.seatIds);

// 6. Broadcast + cleanup
broadcastMultiSeatUpdate(meta.eventId, 'SEAT_BOOKED', meta.seatIds);
await redis.del(`order_meta:${orderId}`);
await redis.del(`payment_timer:${meta.sessionId}`);
```

---

# PART B — Design decisions: what we chose, what we rejected, and why

Each section below follows the same shape: **the question an interviewer would ask → the short answer → the alternatives and exactly how each one fails.**

---

## Decision 1 — Why not pure pessimistic locking (Postgres `FOR UPDATE`) for the whole flow?

**Short answer:** Because the "decide which seats" phase can last minutes, and holding a database row lock for minutes is a resource-exhaustion and scalability disaster.

**What pure pessimistic locking the whole way would look like:**
```
User clicks seat → BEGIN, SELECT ... FOR UPDATE, hold the transaction open
                 → user browses, fills payment form (could be 2-5 minutes)
                 → COMMIT only when they finish
```

**Why this fails:**
- Every customer currently "deciding" would hold an **open database connection and an open transaction** for the entire time they're browsing. With even a few hundred concurrent shoppers, you exhaust your connection pool — the database physically cannot serve that many simultaneous long-lived transactions.
- If a customer's browser tab dies, their network drops, or they just walk away, that transaction may never cleanly close — Postgres doesn't know they've abandoned it. You'd need a separate timeout-and-kill mechanism anyway, which is exactly what TTLs give you for free in Redis.
- Other customers trying to even **view** the seat map (read the current status) can get blocked or slowed by long-held locks on the same rows, depending on isolation level.
- This is the textbook failure mode pessimistic locking is known for: fine for short, fast operations; actively harmful for anything spanning human decision-time.

**What we do instead:** pessimistic locking is used, but **only for a few hundred milliseconds**, at the very end (`FOR UPDATE` inside the short finalize transaction) — never during the multi-minute decision/payment window.

---

## Decision 2 — Why not pure optimistic locking (a `version` column, checked only at the final write) for the whole flow?

**Short answer:** Because pure optimistic locking gives zero feedback during selection — two people could both "select" the same seat and only find out one of them lost at the very last second, after filling in payment details.

**What pure optimistic locking would look like:**
```
User clicks seat → just read current version, remember it client-side, no lock at all
User proceeds through checkout → at the very end:
  UPDATE seats SET status='booked', version=version+1
  WHERE seat_id=? AND version=<the version I originally read>
  → 0 rows updated means someone else got there first
```

**Why this fails for this specific product:**
- Whoever finishes checkout **fastest** wins, regardless of who clicked the seat **first**. A slower typer who genuinely got there first can lose to someone who started later but has saved card details — which feels broken and unfair from a user's perspective.
- The "loser" only finds out **after** doing all the work of selecting seats, navigating to checkout, and entering payment info — a much worse experience than an instant "this seat is taken" the moment they click it.
- There's no natural way to show other viewers "this seat is currently being considered by someone" in real time, because nothing is actually reserved until the very last moment.

**What we do instead:** a fast, instant reservation the moment a seat is clicked (via the Redis Lua lock) — giving immediate feedback — **plus** a final `FOR UPDATE` check in Postgres as a second, independent safety net right before the permanent write. This is a hybrid: pessimistic-*feeling* at selection time (instant reservation), but implemented without ever holding a database transaction open during that window.

---

## Decision 3 — Why Redis instead of just using Postgres for the temporary "hold" state too?

**Short answer:** Because Postgres doesn't have first-class support for "this row should automatically become available again in exactly 10 minutes, with no extra code." Redis's TTL does this natively.

**What "just use Postgres for holds" would require:**
- A `held_until` timestamp column on `seats`.
- A background job (cron, or a `setInterval` loop) that periodically scans for `held_until < now()` and resets those rows — meaning your "release" isn't instant, it's delayed by however often that job runs.
- Every seat-map read now needs to compute "is this technically held but the cleanup job hasn't run yet?" — extra logic that Redis's automatic key expiry gives you for free.

**Why this matters concretely:** with Redis, the moment a hold's TTL hits zero, the very next `GET` on that key returns `nil` — instantly, automatically, no polling, no lag. Recreating that in Postgres means accepting a cleanup-job-interval's worth of staleness, or writing much more complex logic to fake "automatic expiry" that Postgres doesn't natively support.

**What we do instead:** Redis holds all short-lived, frequently-changing state (holds, sessions, payment timers, waiting room). Postgres holds only permanent facts (a seat that's actually sold). This is a very standard "hot path vs. system of record" split.

---

## Decision 4 — Why a Lua script instead of two separate Redis commands (a `GET` then a `SET`)?

**Short answer:** Because "check, then act" as two separate network round-trips is a classic race condition — something else can happen in between.

**What "just do a GET then a SET" would look like:**
```javascript
const val = await redis.get(`seat:${eventId}:${seatId}`);
if (val === 'AVAILABLE') {
  await redis.set(`seat:${eventId}:${seatId}`, `HELD:${holdId}`, 'EX', 600);
}
```

**Why this fails:** between the `GET` finishing and the `SET` being sent, **another request for the same seat can run its own `GET`, also see `AVAILABLE`, and also proceed to `SET`.** Two customers both "successfully" lock the same seat, because neither one's check-and-act happened atomically — Redis processed each individual command instantly, but the *pair* of commands from one request wasn't protected from interleaving with the *pair* from another request.

**What a Lua script fixes:** Redis executes an entire Lua script as **one single, uninterruptible operation** — no other command from any other client can run on that Redis instance while the script is executing. The check and the set happen as one atomic unit; there is no window for another request to sneak in between them.

---

## Decision 5 — Why Lua scripts specifically, instead of Redis `MULTI`/`EXEC` transactions or `WATCH`?

**Short answer:** Because `MULTI`/`EXEC` doesn't support conditional logic ("only proceed if all seats are available"), and `WATCH` still requires a round-trip between the check and the transaction, reopening a small race window.

- **`MULTI`/`EXEC`** queues a batch of commands and runs them together, but it **cannot look at a value and decide whether to run the rest** — it just blindly executes everything queued. We need "check all N seats are available, and only if ALL are, lock all N" — that's a decision, not just a batch. Lua scripts can branch (`if`, `return 0` early) in a way `MULTI`/`EXEC` cannot.
- **`WATCH`** lets you say "abort this transaction if this key changed since I last read it" — closer, but you still do a `GET` (outside the transaction) to decide what to do, then a separate `WATCH` + `MULTI`/`EXEC`. There's a real, if small, gap between reading the value and starting the watched transaction, and the logic for handling a failed/retried `WATCH` adds real complexity for something a single Lua script handles in five lines.
- **Lua** lets us express "loop through all N seats, check each one, and only if every single one is `AVAILABLE`, set all N to `HELD`" as one script that Redis runs as a single atomic unit — no retries, no separate round-trips, no partial-batch ambiguity.

---

## Decision 6 — Why does `FINALIZING` exist as a separate state, instead of going straight from `HELD` to `BOOKED`?

*(Covered in depth in this conversation already — summarized here for completeness.)*

**Short answer:** Because `HELD` is designed to auto-expire (it has a TTL), and that's exactly the one property you cannot allow during the few hundred milliseconds where Postgres is actively writing the permanent record. `FINALIZING` is `HELD`'s identical twin with the TTL surgically removed, used only for that narrow, dangerous window — and because it never claims to be a completed booking, it's always safe to roll back to `AVAILABLE` if the Postgres write fails. Jumping straight to `BOOKED` would mean either lying about what `BOOKED` means (sometimes it's not actually confirmed) or having no honest way to undo a failed write.

---

## Decision 7 — Why two separate timers (10-minute selection, 5-minute payment) instead of one single timer for the whole flow?

**Short answer:** Because "selecting seats" and "completing payment" are different tasks with different natural durations, and coupling them into one timer means a slow checkout page eats into a customer's seat-decision time and vice versa.

**What a single timer would do wrong:** if you gave someone one 10-minute window for the *entire* flow, someone who spends 8 minutes carefully choosing seats would only get 2 minutes to actually pay — through no fault of their own, just because the seat map took a while to load or they were comparing sections. Conversely, someone who picks seats instantly would have 9+ unused minutes "banked," but no way to actually use that slack once they're on the payment page, because the single timer doesn't reset.

**What we do instead:** the 10-minute `session:{sessionId}` key covers only seat selection. Clicking "proceed to payment" creates a **fresh, independent** 5-minute `payment_timer:{sessionId}` — so payment always gets a full, fair 5 minutes regardless of how long selection took.

---

## Decision 8 — Why is `holdId` a separate value from `sessionId`, instead of just using the session ID everywhere?

**Short answer:** Because the Redis seat keys and the Lua scripts only ever need to compare one plain string value (`HELD:{holdId}`) — keeping that string independent from the session's own identity means the Lua scripts never need to know anything about sessions, JSON parsing, or user IDs at all. They just compare strings.

If we'd used `sessionId` directly as the "who holds this" marker, the seat-locking logic (Lua scripts, `redisInventoryService.js`) would need to understand session semantics to do its job — mixing two concerns (session lifecycle vs. seat ownership) that are cleaner kept separate. It also means a session's *internal* identity can change or be regenerated without ever touching the seat locks tied to `holdId`.

---

## Decision 9 — Why `order_items` as a separate table with `price_at_purchase`, instead of just reading the current seat price when generating the confirmation?

**Short answer:** Because seat prices can change after an order is placed (an organizer might reprice a section mid-sale), and a customer's total must reflect what they agreed to pay at checkout — not whatever the price happens to be later.

**What "just read the current price" would break:** if an organizer raises prices between order creation and payment confirmation (even by seconds), a customer could be charged Razorpay's original amount but have their ticket's "true price" on record show a different, newer number — creating a mismatch between what was actually charged and what the system thinks was charged, and no reliable receipt of what the customer actually agreed to.

**What we do instead:** `order_items.price_at_purchase` freezes the price at the moment the order is created — a durable, permanent record of exactly what was agreed to, immune to later price changes.

---

## Decision 10 — Why does `confirmOrder` check idempotency (`status === 'confirmed'` → return existing booking) at all?

**Short answer:** Because payment confirmation can legitimately be triggered more than once for the same order — retried network requests, a user double-clicking "Pay," or (in a webhook-based design) a payment provider resending a callback — and none of those should create a second booking or charge twice.

**What happens without an idempotency check:** if `confirmOrder` ran fully a second time for an already-confirmed order, it would try to `INSERT` tickets that already exist, potentially double-count revenue, or throw confusing errors deep in a transaction instead of cleanly recognizing "this is already done, just return it."

**What we do instead:** the very first thing `confirmOrder` does is check the order's current status. If it's already `confirmed`, it immediately returns the existing booking details without touching Redis or Postgres again — calling this endpoint twice for the same successful payment is completely safe.

---

## Decision 11 — Why re-verify `status = 'available'` with `FOR UPDATE` in Postgres, when Redis already confirmed the hold was valid via the Lua finalize script?

**Short answer:** Defense in depth — Redis and Postgres are two independent systems, and trusting only one of them means a bug or failure in that one system has no safety net.

**Concrete scenario where skipping this check would matter:** suppose there were ever a bug in the Redis logic, a Redis failover event, or some edge case where Redis's view of a seat's state briefly disagreed with Postgres's actual permanent record. If the Postgres write blindly trusted "Redis said this was fine" and skipped its own check, that bug could result in an actual double-booking in the permanent database — the one place where an oversell is truly unrecoverable (real money, real conflicting tickets).

**What we do instead:** Postgres — the actual system of record — independently re-verifies `status = 'available'` for itself, inside a `FOR UPDATE` lock, before writing. This means **even if Redis were somehow wrong, Postgres would still refuse to double-book a seat.** The correctness guarantee doesn't depend on Redis being perfect; it depends on Postgres being the final word, which is exactly what "source of truth" is supposed to mean.

---

## Decision 12 — Why open the Postgres transaction *after* the Lua finalize, instead of wrapping the whole payment verification + finalize sequence in one long transaction?

**Short answer:** Because a database transaction should be held open for the shortest possible time, and Razorpay signature verification (Step 1) doesn't touch the database at all — there's no reason to hold a transaction open for it.

**What a "wrap everything in one transaction" version would cost:** if the transaction opened before verifying the payment signature, and that verification (or any earlier step) took longer than expected, a database row lock would sit open the whole time for no reason — tying up a connection and a lock for work that has nothing to do with the database.

**What we do instead:** everything that doesn't need a database transaction (signature verification, the Lua finalize) happens *before* `BEGIN`. The transaction opens right before the `FOR UPDATE` query and closes immediately after the `INSERT`s — genuinely just milliseconds, minimizing lock contention with every other concurrent booking attempt for the same event.

---

## Decision 13 — Why a Redis Sorted Set for the waiting room, instead of a plain Set or a List?

**Short answer:** Because the waiting room needs two different things at once — FIFO ordering (a List could do this) *and* a way to store each person's expiry time so ghost/abandoned slots can be swept automatically (a plain Set + separate TTL keys cannot do this safely).

**Why a plain Set + separate TTL key (the original, buggy design) fails:** covered in detail earlier in this conversation — the short version is that a Set's membership and a separate TTL key's expiry can drift apart, since nothing links them. When the TTL key expires, nothing tells the Set to remove that member — a permanent "ghost slot" leak.

**Why a List alone isn't enough:** a List gives you ordering, but has no concept of "score" or expiry per item — you'd still need a separate mechanism to track and sweep out abandoned entries, running back into the same problem.

**What a Sorted Set gives you that neither alone does:** the **score** on each member does double duty — as the expiry timestamp for the `admitted:{eventId}` set (self-cleaning via `ZREMRANGEBYSCORE` before every count check) and as the join-timestamp for FIFO ordering in `waiting_room:{eventId}` (`ZRANK` gives exact queue position). One data structure, two jobs, no separate moving parts that can drift out of sync.

---

## Decision 14 — Why WebSockets for seat updates, instead of the frontend just polling `GET /seats` every few seconds?

**Short answer:** Because polling means either wasteful constant requests (if the interval is short) or noticeably stale seat colors (if the interval is long) — a persistent connection lets the server push updates the instant they happen, with neither trade-off.

**What polling would cost:** if you poll every 2 seconds to feel "live enough," you're sending a full seat-map request from every connected browser every 2 seconds — regardless of whether anything changed. For a popular event with hundreds of concurrent viewers, that's a constant, mostly-wasted load on the backend. Poll less often to reduce load, and now seat colors visibly lag behind reality, which looks broken during a high-demand sale.

**What we do instead:** a WebSocket connection per viewer, and the server **pushes** a message only when a seat's state actually changes (`SEAT_HELD`, `SEAT_AVAILABLE`, `SEAT_BOOKED`) — zero wasted requests, and updates arrive the instant they happen rather than on the next poll cycle.

**Important caveat — and a likely interview follow-up:** this WebSocket layer is explicitly **not** part of the correctness guarantee. It's UI-only. If a broadcast message is dropped or a client disconnects, the worst outcome is a seat looking the wrong color for a moment — the actual `ACQUIRE_SEATS` Lua check still runs and correctly rejects a stale click. Real-time updates are about *experience*; the Lua scripts and the Postgres transaction are about *correctness* — two separate concerns, solved by two separate, independent mechanisms. (Worth noting: the waiting room's position polling *does* still use plain HTTP polling rather than WebSocket — a deliberate simplicity trade-off, since queue position doesn't need sub-second freshness the way a live seat map does.)

---

## Decision 15 — Why verify a cryptographic signature from Razorpay instead of just trusting the frontend's "payment succeeded" claim?

**Short answer:** Because the frontend is not a trusted environment — anyone can open browser dev tools and call your API directly with a fabricated "success" response, without ever actually paying.

**What "just trust the frontend" would allow:** if `POST /orders/:orderId/pay` simply finalized the booking whenever the frontend said `{ success: true }`, anyone could get a free ticket by calling that endpoint directly with made-up data — no payment required at all.

**What we do instead:** Razorpay signs its payment confirmation with a secret key only Razorpay and our backend know. `verifyPayment()` recomputes that signature server-side from the raw payment IDs and compares it — if it doesn't match exactly, the claim is rejected regardless of what the frontend sent. This moves the trust boundary to something the client cannot forge.

---

## Decision 16 — Why release *both* the Redis seat holds *and* the waiting-room slot on every failure path, instead of just one or the other?

**Short answer:** Because they represent two independent resources being consumed by the same abandoned customer — releasing only one leaves the other permanently stuck.

If only seats were released on failure, the customer would stop occupying their seats (good), but would still count as "admitted" in the waiting room forever — the exact ghost-slot bug covered earlier, just triggered from a different code path. If only the waiting-room slot were released, the seats they'd selected would remain `HELD` until their TTL eventually expires on its own — meaning those seats stay unavailable to everyone else for up to 10 extra minutes for no reason.

**What we do instead:** every failure/abandonment path (`failOrder`, invalid signature, generic payment exception, explicit cancel, beacon-on-tab-close) calls both `releaseSeats()` (Redis Lua) **and** `releaseSlot()` (waiting room) — treating them as two separate cleanup obligations that both need to happen, every time.

---

## Decision 17 — Why a separate `/cancel-beacon` endpoint instead of just relying on the frontend calling `/cancel` normally when a tab closes?

**Short answer:** Because a normal `fetch()` call can be silently cancelled by the browser the instant a tab starts closing — there's no guarantee it ever reaches the server. `navigator.sendBeacon()` is specifically designed by browsers to survive page unload, but it has a real constraint: it cannot set custom headers, so it can't carry a normal `Authorization: Bearer <token>` header the way an authenticated `fetch()` can.

**What "just use the normal endpoint" would risk:** a customer closing their tab right as `/cancel` fires might have that request aborted mid-flight by the browser tearing down the page — the seats then sit `HELD` until their TTL naturally expires, needlessly blocking them from other buyers for up to 10 minutes.

**What we do instead:** `/cancel-beacon` accepts the JWT in the **request body** instead of a header (verified manually inside the handler with `jwt.verify`), specifically so it can be called via `sendBeacon()`, which browsers guarantee will attempt to send even as the page unloads.

---

## Decision 18 — Why does Postgres remain the permanent source of truth, instead of just keeping Redis as the permanent record too (skipping Postgres almost entirely)?

**Short answer:** Because Redis is fundamentally an in-memory store — even with persistence options enabled, it's not designed or battle-tested as the durable system of record for financial/transactional data the way a relational database is, and it lacks the relational integrity guarantees (foreign keys, multi-table transactions, mature backup/restore tooling) that a real booking system needs for things like refunds, reporting, and auditing.

**What "Redis as permanent record" would risk:** losing a Redis instance (crash, misconfiguration, a bad deploy) risks losing the actual record of who bought what — completely unacceptable for something involving real payments and legal proof-of-purchase. Postgres's transactional guarantees (`BEGIN`/`COMMIT`/`ROLLBACK`, foreign key constraints tying `tickets` to `orders` to `seats`) are exactly the tooling built for "this must never be lost or become inconsistent."

**What we do instead:** Redis handles the *live, fast-changing, short-lived* part of the flow (who's currently deciding, who's currently paying) — data that's fine to lose if a Redis instance restarts, because it would just mean some in-progress checkouts get reset, not that historical purchases vanish. Postgres handles everything that must survive forever.

---

## Decision 19 — Why does a seat's `version` column get incremented even though we're already using `FOR UPDATE` (a pessimistic lock) for the same write?

**Short answer:** `FOR UPDATE` protects against concurrent writes *within this transaction's lifetime*. The `version` column is a lightweight, general-purpose safeguard for any *other* code path that might read a seat's data and act on it later, outside of a transaction that holds a lock — a defensive habit that costs almost nothing and closes off an entire class of future bugs if the codebase grows new features that touch seat status.

---

## Anticipated broader interview questions

**"What's your system's consistency model — is it eventually consistent or strongly consistent?"**
Strongly consistent for the actual booking write (Postgres transaction with `FOR UPDATE`), but the WebSocket seat-map updates are best-effort/eventually consistent — a client's *view* of the seat map can be briefly stale, but the underlying data never is, and every write path re-validates against Redis/Postgres regardless of what the client believes.

**"What happens if Redis goes down?"**
The live booking flow (selection, holds, waiting room) stops working, since it all depends on Redis. Already-`BOOKED` seats are safe — that state lives in Postgres too (seats table `status='booked'`), so no confirmed bookings are lost. This is a real, honest limitation worth naming rather than hiding: Redis is a single point of failure for the *live* flow in the current design, and a production system would want Redis Cluster/Sentinel for high availability.

**"What happens if the server crashes while a seat is `FINALIZING`?"**
Currently, nothing recovers it automatically — this is a known gap (see the earlier code review). `FINALIZING` has no TTL by design (see Decision 6), which is correct for the normal case, but means a crash at that exact moment leaves the seat stuck. The fix would be a periodic reconciliation job that treats any `FINALIZING` state older than a couple of minutes as failed and rolls it back.

**"How would this scale to multiple server instances?"**
The Redis and Postgres logic is already stateless-server-friendly — any server instance can handle any request, since all the real state lives in Redis/Postgres, not in server memory. The one exception is the WebSocket layer's in-memory `Map` of connected clients per event (`eventRooms`) — with multiple server instances, a client connected to server A wouldn't receive broadcasts triggered by a booking handled on server B. That would need a pub/sub layer (e.g. Redis Pub/Sub) so any server instance can broadcast to clients connected to any other instance.