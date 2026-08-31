---
phase: 3
title: "Hybrid Metering & Double-Entry Billing Engine"
status: pending
priority: P1
effort: "6d"
dependencies: ["02"]
---

# Phase 03: Hybrid Metering & Double-Entry Billing Engine

## Overview
Implement a high-precision, fraud-resistant metering and billing engine for CloudHarness HaaS. The engine captures workspace lifecycle events (duration: open -> close / suspend) alongside tool execution request counts, enforces auto-idle sleep after 15 minutes of inactivity, maintains an immutable double-entry financial ledger in PostgreSQL, and integrates with Polar.sh and Stripe Checkout using raw-body cryptographic signature verification with comprehensive support for top-ups, refunds, and dispute holds.

## Requirements
- **Functional:**
  - **Hybrid Metering Model:**
    - Primary Meter: Workspace duration calculated per millisecond by resource tier (Micro: 1 vCPU/2GB RAM @ $0.04/hr, Standard: 2 vCPU/4GB RAM @ $0.08/hr, Heavy: 4 vCPU/8GB RAM @ $0.16/hr).
    - Secondary Meter: Request count (Tool calls). Each 1 Compute Unit (hour) includes 100 free tool calls; excess calls billed at $0.002 per 100 calls.
  - **Auto-Idle Sleep (Cost Optimizer):** Detect 15 minutes of inactivity (no MCP tool calls); transition workspace container from `RUNNING` to `SUSPENDED` (RAM snapshot / disk pause) and immediately stop the duration meter. Auto-resume on next incoming request in < 2 seconds.
  - **Double-Entry Financial Ledger (PostgreSQL):**
    - Every financial event creates balanced debit and credit entries (`sum(debits) - sum(credits) == 0`).
    - Accounts: `user_prepaid_wallet` (Asset/Liability), `system_compute_revenue` (Revenue), `system_request_revenue` (Revenue), `gateway_clearing_polar` (Asset), `gateway_clearing_stripe` (Asset), `dispute_escrow` (Liability).
    - User balance is a guaranteed projection derived from locked ledger entries.
  - **Payment Webhook Verification (Raw-Body Buffer):**
    - Verify HMAC-SHA256 signatures against unmodified raw byte buffers (`req.rawBody`) before JSON parsing.
    - Enforce timestamp tolerance (< 300 seconds) and check live vs test environment flags.
    - Lifecycle coverage: `payment.succeeded` (credit wallet), `refund.created` (debit wallet), `charge.dispute.created` (hold funds in dispute escrow), `charge.dispute.won` / `lost`.
  - **Quota & Balance Protection:**
    - Real-time balance check on `open_workspace` / `renew_lease`.
    - Warning email / webhook when balance falls below $2.00.
    - Grace period: Allow 30 minutes to cleanly close active workspace if balance reaches $0.00; block new workspace creation immediately.
  - **Customer Usage Dashboard:** Real-time billing breakdown, active workspace cost counter, invoice history, and CSV export.
- **Non-functional:**
  - Financial Idempotency: Duplicate webhook events (identified by unique provider transaction ID) or replayed disconnect reports cannot result in duplicate credits or debits.
  - Sub-second duration precision with ceiling rounding to nearest 1 minute.

## Architecture & Metering Lifecycle

```text
  [MCP Client Request]
          │
          ▼
┌──────────────────┐    Auto-Sleep Timer (15 min)
│  API / Gateway   ├─────────────────────────────────┐
└─────────┬────────┘                                 │
          │ 1. Verify Balance >= $0.50               ▼
          ▼                              ┌──────────────────────┐
┌──────────────────┐                     │ Workspace Suspended  │
│ Control Plane    │                     │ (Meter PAUSED)       │
└─────────┬────────┘                     └──────────┬───────────┘
          │ 2. Allocate & Start Timer               │
          ▼                                         │ New Request
┌──────────────────┐                                │
│ Worker Node      │                                ▼
│ - Local Sandbox  ├─────────────────────► Resume in < 2s
└─────────┬────────┘
          │ 3. Workspace Close / Suspend Event
          ▼
┌───────────────────────────────────────────────────────────────┐
│              Double-Entry Financial Ledger                    │
│  Debit: user_prepaid_wallet                                   │
│  Credit: system_compute_revenue & system_request_revenue      │
│  (Atomic PostgreSQL Transaction with balanced debit/credit)   │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────┐
│        Payment Integration (Polar.sh / Stripe Raw Webhook)    │
│  - Raw-body HMAC verification with 300s timestamp tolerance   │
│  - Credit wallet: Debit gateway_clearing / Credit user_wallet │
│  - Refund/Dispute: Debit user_wallet / Credit dispute_escrow  │
└───────────────────────────────────────────────────────────────┘
```

## Related Code Files
- Create: `apps/api/src/billing/metering-service.ts` (Event accumulator and usage calculation)
- Create: `apps/api/src/billing/double-entry-ledger.ts` (Balanced double-entry ledger manager and atomic reservation)
- Create: `apps/api/src/billing/idle-detector.ts` (15-minute auto-sleep coordinator)
- Create: `apps/api/src/billing/polar-webhook-handler.ts` (Raw-body Polar.sh event processor)
- Create: `apps/api/src/billing/stripe-webhook-handler.ts` (Raw-body Stripe Checkout processor)
- Create: `apps/api/src/routes/billing-router.ts` (User balance, usage history, top-up API)
- Modify: `apps/api/src/app.ts` (Mount `/api/v1/billing` and raw-body webhook routes)
- Create: `packages/contracts/src/billing-contracts.ts` (Schemas for invoices, ledger entries, and tiers)
- Modify: `apps/runner/src/workspace-service.ts` (Emit precise start/pause/resume/close timestamps)

## Implementation Steps
1. **Database Schema & `post_journal(...)` Stored Procedure:**
   - Create tables: `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `workspace_metering_sessions`, `payment_webhook_events`.
   - Use integer micro-USD currency units ($1.00 = 1,000,000 micro-USD) for sub-cent $0.002 precision.
   - Implement PostgreSQL stored procedure `post_journal(entries JSONB)` executing in a single atomic transaction:
     - Locks involved accounts in deterministic order (`FOR UPDATE`).
     - Validates exact balance (`sum(debits) == sum(credits)`).
     - Validates single currency and customer tenant scope.
     - Sets transaction status `POSTED` (append-only; updates and deletes strictly rejected by database triggers).
2. **Atomic Pre-Admission Credit Reservation:**
   - Before workspace allocation, execute `reserve_compute_credits(user_id, amount)` placing an atomic hold for 1 hour of compute (e.g. $0.08 / 80,000 micro-USD).
   - Workspace open is rejected if available unreserved balance < 1-hour tier rate.
   - Active workspaces settle the prior hour's reservation and reserve the next hour periodically.
3. **Implement Workspace Lifecycle Metering (`metering-service.ts`):**
   - Record `started_at`, `paused_at`, `resumed_at`, `closed_at` on every workspace state change.
   - Aggregate tool call counts per session.
   - Settle finalized duration and request overages through `post_journal`.
4. **Build Auto-Idle Sleep Mechanism (`idle-detector.ts`):**
   - Track `last_tool_call_timestamp` per active workspace.
   - Background worker checks every 60s for workspaces idle > 15 minutes.
   - Send `PAUSE_WORKSPACE` command to worker node and emit `paused` metering event.
5. **Integrate Raw-Body Payment Webhooks (Polar.sh & Stripe):**
   - Configure Express raw body buffer parser on `/api/v1/webhooks/*`.
   - Verify HMAC signatures using raw payload bytes and check timestamp (< 300s).
   - Deduplicate incoming webhook events by composite key `(gateway, webhook_event_id)`.
   - Settle top-up credits into customer wallet via `post_journal` linked to `(gateway, payment_intent_id)`.
6. **Handle Refunds and Disputes:**
   - On `charge.dispute.created`, move disputed funds from user wallet to `dispute_escrow`.
   - If user balance becomes negative, freeze workspace creation until balance is restored.
## Success Criteria
- [ ] Opening a Standard workspace (2 vCPU/4GB RAM) for 30 minutes with 50 tool calls deducts exactly $0.04 via a balanced double-entry ledger transaction.
- [ ] Exceeding 100 tool calls in a 1-hour session correctly bills excess requests at $0.002/100 calls.
- [ ] Inactivity of 15 minutes suspends container and halts duration billing.
- [ ] Tool execution on suspended container resumes execution in < 2 seconds and restarts duration billing.
- [ ] Polar.sh and Stripe webhooks verify raw body signatures and reject tampered or expired (>300s) payloads.
- [ ] Duplicate webhook deliveries return HTTP 200 OK without creating duplicate ledger entries.

## Risk Assessment
- **Risk:** Network partition prevents worker node from sending `close_workspace` event.
  - *Observable Signal:* Open metering session on a disconnected node.
  - *Response:* Hard ceiling of 8 hours max per session; freeze metering calculation at the last validated heartbeat timestamp.
- **Risk:** Dispute or chargeback on deposited credits.
  - *Observable Signal:* `charge.dispute.created` webhook received.
  - *Response:* Atomic ledger transaction moves funds to dispute escrow account and notifies customer of account hold.
