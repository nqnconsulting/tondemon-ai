# Contributing

Bug reports and pull requests are welcome.

## Getting set up

```bash
npm install
npm run build
node scripts/smoke-test.mjs    # should diagnose the bundled incident
```

## Before opening a PR

```bash
npm run typecheck   # tsc --noEmit — must be clean
npm run eval:tools  # tool-level evals
node scripts/smoke-test.mjs
```

## Where things live

- `src/tools.ts` — the agent-facing tool contract. Changing it affects every mode, so change it
  deliberately.
- `src/sources/` — one implementation per mode (demo, live logs, Anypoint). Adding a new backend
  (Splunk, ELK, CloudWatch) means adding a `Source`, not touching `tools.ts`.
- `src/adapters/muleLog.ts` — the Mule runtime log parser. It must stay **client-agnostic**: no
  assumed naming conventions, prefixes or customer-specific shapes.
- `src/data/` — the bundled demo estate. Keep it fictional.

## House rules

- **No real customer data.** Not in code, tests, fixtures, docs or commit messages. No real
  hostnames, org names, credentials or log excerpts from a live estate.
- **Read-only against live systems.** The Anypoint source only issues GETs, and it should stay
  that way.
- Prefer honest "unavailable" answers over inferred ones — if the data genuinely isn't in the
  source, say so rather than guessing.
