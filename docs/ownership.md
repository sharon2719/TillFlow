# Ownership

TillFlow is built by two people: sharon2719 and Gatchang-nyawargak. Per the capstone's
ownership rule, every primary area still needs exactly one named DRI — "everyone owns it"
is not accepted, and each area is defended live by the person who actually owns it.

| Primary area | DRI | Contact | Owns and decides |
|---|---|---|---|
| Product + POS | sharon2719 | sharon2719@users.noreply.github.com | Tenant model, frontend flow, POS API, sale state, contracts and validation boundaries. |
| Payments + integrity | Gatchang-nyawargak | nyawargakgatchang@gmail.com | Daraja STK/B2C, callbacks, payment/payout state, idempotency, reconciliation and replay. Commission's payout logic is grouped here too — it's a money-integrity concern (no double-pay), not a POS-product concern. Also owns the payment and commission test evidence and the money-path proof. |
| Platform + delivery | sharon2719 | sharon2719@users.noreply.github.com | Terraform, IAM, ECS, data services, caching, GitHub Actions, CodePipeline and scans. |
| Reliability + operations | sharon2719 | sharon2719@users.noreply.github.com | SLIs/SLOs, budgets, ADOT/Grafana, k6, alerts, recovery experiments and runbook. |

**This split is confirmed, grounded in the actual git history, not a proposal.**

Gatchang-nyawargak's recorded contributions include:

- **Foundational service implementation** (`0ff6402`, "Implement Commission and Web
  services"): the Payments, Commission, and Web service scaffolding and first working
  implementations, including their `app.ts`, `index.ts`, and `logger.ts` files;
- **Money-path implementation**: the initial payment and commission logic, payment tests,
  commission tests, and the original sale-recording implementation in
  `services/pos/src/sales.ts` with its tests;
- **Delivery and CI foundations**: service package/build configuration, Docker support,
  dependency-lock updates, and the initial CI workflow changes shipped with the services;
- **Pipeline and platform hardening** (`61f35bf`, `fix failing pipeline`, and `7db106d`,
  `made fixes`): the Terraform lockfile repair, ECS task-definition changes, ADOT health
  ordering, and the reviewed saved-plan infrastructure apply workflow;
- **Evidence and handoff material** (`0087bed`, `final updates`, and `7db106d`): updates
  to the payments-integrity, product-POS, and reliability-operations evidence indexes,
  plus the README and operational handoff material.

This is a contribution record, not a claim that one person owns every touched path. The
current DRI table remains the decision boundary: Gatchang-nyawargak is accountable for
Payments + integrity and its commission/money-flow proof, while sharon2719 remains the DRI
of record for Product + POS, Platform + delivery, and Reliability + operations.

Product + POS crosses both people's work in practice (sharon2719 built the tenant/auth
model; Gatchang-nyawargak authored the original sale-recording implementation and tests in
`services/pos/src/sales.ts`) — sharon2719 is DRI of record for defending it, but
Gatchang-nyawargak's sales-recording work is a real, material contribution to the same area
and is named as such here, not folded silently into someone else's ownership.

## Cross-review

Each DRI reviews the *other* person's area's PRs before a gate closes — sharon2719 reviews
Payments + integrity PRs, Gatchang-nyawargak reviews Platform + delivery and Reliability +
operations PRs. Note anything that would have bounced in a real review in
`docs/scar-log.md`.

## CODEOWNERS

`/CODEOWNERS` maps each path to its actual DRI. The handles in that file are the confirmed
repository identities for the two contributors: `@sharon2719` and `@Gatchang-nyawargak`.
GitHub branch protection is an external repository setting, so this file records the
intended review ownership while the pull-request template records the required human
cross-review and any release-freeze exception.
