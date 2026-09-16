# Ownership

TillFlow is built by two people: sharon2719 and Gatchang-nyawargak. Per the capstone's
ownership rule, every primary area still needs exactly one named DRI — "everyone owns it"
is not accepted, and each area is defended live by the person who actually owns it.

| Primary area | DRI | Contact | Owns and decides |
|---|---|---|---|
| Product + POS | sharon2719 | sharon2719@users.noreply.github.com | Tenant model, frontend flow, POS API, sale state, contracts and validation boundaries. |
| Payments + integrity | Gatchang-nyawargak | nyawargakgatchang@gmail.com | Daraja STK/B2C, callbacks, payment/payout state, idempotency, reconciliation and replay. Commission's payout logic is grouped here too — it's a money-integrity concern (no double-pay), not a POS-product concern. |
| Platform + delivery | sharon2719 | sharon2719@users.noreply.github.com | Terraform, IAM, ECS, data services, caching, GitHub Actions, CodePipeline and scans. |
| Reliability + operations | sharon2719 | sharon2719@users.noreply.github.com | SLIs/SLOs, budgets, ADOT/Grafana, k6, alerts, recovery experiments and runbook. |

**This split is a proposal, not yet confirmed with Gatchang-nyawargak directly** — it's
based on what's actually been built so far (sharon2719: G0/G1 in full, plus tenant setup;
Gatchang-nyawargak: sales recording, Payments, Commission, Web) rather than a conversation
between the two of you about it. Since the brief caps an individual's score at 59 if they
have no credible primary area, confirm this explicitly rather than let it stand by default.

Product + POS crosses both people's work in practice (sharon2719 built the tenant/auth
model, Gatchang-nyawargak built sale recording and the web stub) — sharon2719 is DRI of
record for defending it, but Gatchang-nyawargak's sales-recording work is real, material
contribution to the same area and should be named as such in the live defence, not folded
silently into someone else's ownership.

## Cross-review

Each DRI reviews the *other* person's area's PRs before a gate closes — sharon2719 reviews
Payments + integrity PRs, Gatchang-nyawargak reviews Platform + delivery and Reliability +
operations PRs. Note anything that would have bounced in a real review in
`docs/scar-log.md`.

## CODEOWNERS

`/CODEOWNERS` maps each path to its actual DRI. `@Gatchang-nyawargak` is used as her GitHub
handle based on the commit author name on PR #10 — confirm this is actually her handle
(not just her display name) before relying on it for branch protection.
