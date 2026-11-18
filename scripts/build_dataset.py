"""Single source of truth for the dataset bundle.

Regenerates, together:
  data.json              what the browser loads
  dataset/manifest.json  what the server validates against (version, ids, editable fields)
  supabase/seed.sql      what Supabase enforces (current version, allowed records, field ranges)

If the dataset changes, run this script and apply supabase/seed.sql in the same release.
The server refuses any request whose dataset_version differs from the bundled manifest,
and Supabase refuses writes whose dataset_version is not the current one.

    python3 scripts/build_dataset.py
"""
import hashlib, json, pathlib
import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "data" / "source"

EDITABLE = {  # record-cell numeric editing: field -> (min, max, unit, label)
    "runway_months":     (0, 60, "months", "Runway"),
    "mrr_usd":           (0, 50_000_000, "USD", "Monthly revenue"),
    "mom_growth_pct":    (-100, 500, "%", "Monthly growth"),
    "monthly_churn_pct": (0, 100, "%", "Monthly churn"),
    "pmf_score_pct":     (0, 100, "%", "PMF score"),
    "ltv_cac_ratio":     (0, 100, "x", "LTV / CAC"),
}

s = pd.read_csv(SRC / "dim_startup.csv")
d = pd.read_csv(SRC / "fact_decision.csv")
q = pd.read_csv(SRC / "fact_survey_response.csv")

# Ids must be contiguous: the browser and the server address records by position.
assert (s.startup_id == [f"S{i+1:05d}" for i in range(len(s))]).all(), "startup ids not contiguous"
assert (d.decision_id == [f"D{i+1:05d}" for i in range(len(d))]).all(), "decision ids not contiguous"
assert d.startup_id.isin(s.startup_id).all(), "decision points to unknown startup"

s["top10"] = s.top_10pct_performer.map({"Yes": 1, "No": 0})
s["founded_year"] = s.founded_year.astype(str)
idx = {sid: i for i, sid in enumerate(s.startup_id)}
d["si"] = d.startup_id.map(idx)
d = d.merge(s[["startup_id", "sector", "stage", "funding_type", "region", "founder_age_band"]], on="startup_id")
d = d.sort_values("decision_id").reset_index(drop=True)
d["decision_year"] = d.decision_year.astype(str)
d["raise_attempt"] = (d.option_chosen == "Raise now").astype(int)
d["raise_closed"] = ((d.option_chosen == "Raise now") & (d.amount_raised_usd > 0)).astype(int)
q["would_sell"] = q.would_accept_usd10m_offer_today.map({"Yes": 1, "No": 0})

def enc(df, cats, nums):
    dicts = {c: sorted(df[c].dropna().astype(str).unique().tolist()) for c in cats}
    look = {c: {v: i for i, v in enumerate(dicts[c])} for c in cats}
    rows = []
    for r in df[cats + nums].itertuples(index=False, name=None):
        row = [(-1 if pd.isna(v) else look[c][str(v)]) for c, v in zip(cats, r[:len(cats)])]
        for v in r[len(cats):]:
            if pd.isna(v): row.append(None)
            else:
                v = round(float(v), 2); row.append(int(v) if v.is_integer() else v)
        rows.append(row)
    return {"cats": cats, "nums": nums, "dicts": dicts, "rows": rows}

S = enc(s, ["sector", "stage", "funding_type", "region", "business_model", "founder_age_band", "prior_founder_outcome",
            "cofounder_relationship", "uses_hypothesis_testing", "scaled_before_pmf", "recommended_fix", "pivot_signal",
            "raise_readiness", "founded_year", "outcome_36m"],
        ["survived_36m", "top10", "runway_months", "pmf_score_pct", "mom_growth_pct", "monthly_churn_pct", "ltv_cac_ratio",
         "industry_experience_yrs", "founder_age", "funding_raised_usd", "mrr_usd", "team_size"])
D = enc(d, ["decision_type", "evidence_basis", "choice_matched_signal", "option_chosen", "trigger", "decision_year",
            "sector", "stage", "funding_type", "region", "founder_age_band", "round_sought", "outcome_12m"],
        ["si", "decision_paid_off", "raise_attempt", "raise_closed", "mrr_change_12m_pct", "experiments_run_before"])
Q = enc(q, ["primary_success_definition", "survey_wave", "sector", "stage", "funding_type", "region", "age_band", "founder_type"],
        ["target_horizon_years", "confidence_of_reaching_it_pct", "target_value_usd", "control_over_wealth_1to5", "would_sell"])

editable = {k: {"min": v[0], "max": v[1], "unit": v[2], "label": v[3]} for k, v in EDITABLE.items()}
body = json.dumps({"S": S, "D": D, "Q": Q, "editable": editable}, separators=(",", ":"), sort_keys=True)
version = hashlib.sha256(body.encode()).hexdigest()[:16]
data = json.dumps({"version": version, "editable": editable, "counts": {"startups": len(s), "decisions": len(d), "survey": len(q)},
                   "S": S, "D": D, "Q": Q}, separators=(",", ":"))
(ROOT / "data.json").write_text(data)

manifest = {
    "version": version,
    "counts": {"startups": len(s), "decisions": len(d), "survey": len(q)},
    "record_id": {"prefix": "S", "width": 5, "first": 1, "last": len(s)},
    "editable": editable,
    "source": "Synthetic. generate_startup_dataset.py, seed 20261110, cut-off 2026-09-30",
}
(ROOT / "dataset" / "manifest.json").write_text(json.dumps(manifest, indent=2))

fields = ",\n  ".join(f"('{k}', {v[0]}, {v[1]}, '{v[2]}')" for k, v in EDITABLE.items())
seed = f"""-- Generated by scripts/build_dataset.py. Apply in the same release as data.json.
-- Dataset version {version}: {len(s)} startups, {len(d)} decisions, {len(q)} survey rows.
begin;
update dataset_manifest set is_current = false where is_current;
insert into dataset_manifest (version, startups_n, decisions_n, survey_n, is_current)
values ('{version}', {len(s)}, {len(d)}, {len(q)}, true)
on conflict (version) do update set is_current = true;

insert into allowed_record (record_id, dataset_version)
select 'S' || lpad(g::text, 5, '0'), '{version}' from generate_series(1, {len(s)}) g
on conflict (record_id) do update set dataset_version = excluded.dataset_version;
delete from allowed_record where dataset_version <> '{version}';

delete from editable_field where field not in ({", ".join(f"'{k}'" for k in EDITABLE)});
insert into editable_field (field, min_value, max_value, unit) values
  {fields}
on conflict (field) do update set min_value = excluded.min_value, max_value = excluded.max_value, unit = excluded.unit;
commit;
"""
(ROOT / "supabase" / "seed.sql").write_text(seed)
print("version", version, "| data.json KB", len(data) // 1024)
