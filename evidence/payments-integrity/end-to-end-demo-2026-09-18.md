# End-to-end demo: sale -> STK push -> Daraja callback -> commission close (G2/G5)

**Date:** 2026-09-18. **Target:** the real deployed AWS stack
(`https://6lak1mzcai.execute-api.eu-west-1.amazonaws.com`), real Daraja sandbox, not the
fake adapter. **Raw transcript:** `evidence/product-pos/e2e-demo-transcript-2026-09-18.txt`
(every real HTTP request/response, timestamped).

This is a terminal transcript, not a screen-recorded video - if the defence specifically
needs a video artifact, that requires recording a screen, which isn't something this session
can produce; the script below is exactly reproducible on camera in about 2 minutes if a
video is still wanted; see "What this doesn't cover" below for what a video-recorded run
would show that this one legitimately can't (a real "paid" outcome).

## What actually happened, chronologically

1. Created a real tenant, till (5% commission), and recorded a real sale (KES 200 total, 2
   items) against the live `pos` service.
2. Pushed a real STK request through the live `payments` service to the real Daraja sandbox
   for that exact sale - got back a real Safaricom `checkoutRequestId`
   (`ws_CO_180920261819471708374149`), status `pending`.
3. **Daraja's sandbox delivered a genuine inbound callback 28 seconds later** - the first
   time this has ever been directly observed in this project (two earlier dedicated tests,
   `evidence/payments-integrity/daraja-sandbox-verification-2026-09-16.md`, waited 13+ and
   7+ minutes with nothing arriving). Confirmed real, not something this session sent:
   `user-agent: ReactorNetty/1.2.9` (a Java client, not curl/this session's tooling), a
   `businessshortcode: 174379` header (Daraja's real sandbox shortcode), source IP in a
   Kenyan range - all visible in `/devops-g5/payments`'s own access log.
4. That real callback's result: `ResultCode 1037, "No response from user."` - a genuine
   decline, not a timeout. Expected: the shared sandbox test MSISDN
   (`254708374149`, Safaricom's own published test number) has no real phone attached to
   ever approve the STK prompt, so Daraja legitimately reports no response.
5. **An accidental, real replay-safety proof:** this session's own manual callback attempt
   (sent because step 3's result wasn't visible yet at send time) arrived 18 seconds *after*
   Daraja's real one, racing it, and was correctly rejected: `"already resolved, callback
   ignored"`. This is the replay-safety guarantee
   (`services/payments/test/payments.test.ts:154`) holding under a genuine race with
   Daraja's own infrastructure, not just a deterministic unit test.
6. Ran commission close for the day with this sale marked by its real outcome
   (`paymentStatus: "failed"`): **`eligibleSales: 0, payouts: []`** - the failed payment was
   correctly excluded from any B2C payout, live, for real, against a real (if declined)
   Daraja transaction.

## What this doesn't cover

The `sale -> paid -> close -> commission -> B2C` success path specifically was **not**
reached with a real Daraja completion in this run, because Daraja's sandbox behavior for the
shared test MSISDN is a legitimate decline (step 4), not something this system controls or
can force to succeed. That leg is proven instead by:
- `services/commission/test/commission.test.ts` and `services/payments/test/payments.test.ts`
  (deterministic, against real response shapes, not the fake adapter's flat shape).
- The fake adapter (`FakeMpesaAdapter`) is what a screen-recorded demo video should use if
  one is still wanted for the defence, specifically *because* it can deterministically reach
  "paid" on command, which the real sandbox has now been shown twice to not reliably do
  either way (once nothing arrived at all, once it arrived and declined).

Both halves are real: this run proves the real integration's callback handling and
replay-safety against genuine Daraja traffic; the unit suites prove the payout path that
the real sandbox's test number doesn't exercise. Presenting only one half would overstate
what either actually shows.
