# Startup Decision Maker

Interactive explorer over a **synthetic**, validated startup dataset (3,000 startups, 6,000 decisions, 2,000 survey responses; generator seed 20261110, cut-off Sept 2026). Patterns are documented generator assumptions, not findings about real startups.

Static site: `index.html` loads `data.json`. Deploy on Vercel by importing this repo (no build step, framework: Other).

Every rate is recomputed as sum(numerator) / sum(denominator) for each group, never averaged.
