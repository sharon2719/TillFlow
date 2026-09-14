# Ownership

TillFlow is being built solo. Per the capstone's ownership rule, every primary area still
needs exactly one named DRI recorded before G0 — "everyone owns it" is not accepted even
for a group of one, so this file exists to make that assignment explicit rather than implied.

| Primary area | DRI | Contact | Owns and decides |
|---|---|---|---|
| Product + POS | sharon2719 | sharon2719@users.noreply.github.com | Tenant model, frontend flow, POS API, sale state, contracts and validation boundaries. |
| Payments + integrity | sharon2719 | sharon2719@users.noreply.github.com | Daraja STK/B2C, callbacks, payment/payout state, idempotency, reconciliation and replay. |
| Platform + delivery | sharon2719 | sharon2719@users.noreply.github.com | Terraform, IAM, ECS, data services, caching, GitHub Actions, CodePipeline and scans. |
| Reliability + operations | sharon2719 | sharon2719@users.noreply.github.com | SLIs/SLOs, budgets, ADOT/Grafana, k6, alerts, recovery experiments and runbook. |

## Cross-review

The brief also asks that every member cross-review another's area. Solo, that review has
to be adversarial-self-review instead of a second person: before closing each gate, re-open
the previous gate's PRs from the *other* area's perspective (e.g. read the Payments PRs as
if auditing them for the Platform gate) and note anything that would have bounced in a real
review in `docs/scar-log.md`.

## CODEOWNERS

`/CODEOWNERS` maps every path in this repo to the DRI above, via the GitHub handle
`@sharon2719`. Note: with a single-person repo, GitHub's "require review from Code Owners"
branch protection can't be satisfied by self-review by default — either leave that rule off
solo, or enable "Allow specified actors to bypass required pull requests" for this account
if the assessment wants to see PRs used anyway.
