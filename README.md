# Startup Decision Maker

Decision dashboard for founders over a **synthetic**, validated dataset (3,000 startups, 6,000 decisions,
2,000 survey responses; generator seed 20261110, cut-off Sept 2026). Patterns are documented generator
assumptions, not findings about real startups.

## How it fits together

| Part | Where | Role |
|---|---|---|
| Interface | `index.html` | Overview → Segment → Record, sharing one state (metric, filters, segment, record) kept in the URL |
| KPI logic | `lib/metrics.js` | Imported by the browser **and** the server, so emails and audit rows use the dashboard's exact numbers |
| Server | `api/*.js`, `lib/server.js`, `lib/actions.js` | Passcode, recipient allowlist, exact previews, confirm, Resend, Supabase, read-back verification |
| Database | Supabase project `baxldqcehgznbsyrflbf` | `action_log`, `record_edits`, `data_issues`, plus `dataset_manifest`, `allowed_record`, `editable_field` guards |
| Dataset | `data.json`, `dataset/manifest.json`, `supabase/seed.sql` | All three generated together by `scripts/build_dataset.py` |

## Actions

| Action | Attached to | Sends email | Writes |
|---|---|---|---|
| Share finding | The selected KPI card (Overview) | Yes | `action_log` |
| Assign investigation | The selected bar (Segment) | Yes, to the assignee | `action_log` |
| Edit value | A numeric cell on a record (Record) | No | `record_edits` + `action_log` |
| Report data issue | A record, or an entry in its audit trail | Yes, to the data owner by default | `data_issues` + `action_log` |

Every action runs **compose → exact preview → confirm → verify**. The preview is rendered by the server; the
commit re-renders it and refuses if anything differs from what you saw (wording, recipients or data).
After committing, the server reads the result back from Supabase (and asks Resend for delivery status)
and shows each check.

## Server settings (Vercel → Project → Settings → Environment Variables)

| Variable | Example | Notes |
|---|---|---|
| `DASHBOARD_PASSCODE` | a long random phrase | Required for any action. The site is public; this is the lock. |
| `SUPABASE_URL` | `https://baxldqcehgznbsyrflbf.supabase.co` | |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase → Project settings → API keys | Secret. Server only. |
| `RESEND_API_KEY` | `re_…` | Secret. Server only. |
| `RESEND_FROM` | `Startup Decision Maker <reports@yourdomain.com>` | Must be a domain verified in Resend. `onboarding@resend.dev` only delivers to your own Resend account email. |
| `ALLOWED_RECIPIENTS` | `you@gmail.com,@ie.edu` | Comma list of exact addresses and/or `@domain` entries. Nothing else can receive mail. |
| `DATA_OWNER_EMAIL` | `you@gmail.com` | Default recipient for data issues. Must be on the allowlist. |
| `PUBLIC_BASE_URL` | `https://startup-decision-maker.vercel.app` | Optional. Used for the "open this view" link in emails. |

Without these the dashboard still works read-only and says which settings are missing.

## Changing the dataset

Do not change labels or `data.json` by hand. Replace the CSVs in `data/source/`, then:

```bash
python3 scripts/build_dataset.py   # rewrites data.json, dataset/manifest.json, supabase/seed.sql
npm test                           # 24 server checks
```

Apply `supabase/seed.sql` to Supabase in the same release. The version hash ties the three together:
the server refuses requests from a page on another version, and Supabase refuses writes for a version
that is not current.

## Local run

```bash
MOCK=1 node scripts/dev_server.mjs    # in-memory Supabase and Resend, passcode: test-pass
```
