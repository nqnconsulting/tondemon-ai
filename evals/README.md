# Evals — certify the expertise on any LLM

Two layers, one shared dataset ([`dataset/cases.jsonl`](./dataset/cases.jsonl)). This is what lets
you say to a client *"yes, it works on the model you want"* — and prove it.

```
dataset/cases.jsonl   ← single source of truth: question + expected tool output + answer rubric
        │
        ├── Layer 1: tool-evals.mjs   →  deterministic, NO LLM        (certifies the SERVER)
        └── Layer 2: promptfoo.yaml    →  agent-level, ANY LLM         (certifies the MODEL)
```

## Layer 1 — deterministic tool evals (no model, no API key)

Drives the MCP server and asserts the **tool outputs** (tool-correctness, argument-correctness).
Because the tools are deterministic, this is fully model-agnostic and CI-friendly.

```bash
npm run build
npm run eval:tools          # → ✓/✗ per case, non-zero exit on failure
```

Run this on every code change. It guards the expertise-as-code regardless of which LLM a client
later picks.

## Layer 2 — agent-level evals (swap in any LLM)

Checks that a *model* + the [playbook](../playbook/PLAYBOOK.md) + the tools produces a faithful,
playbook-compliant answer (uses LLM-as-judge `llm-rubric`). Model-agnostic by config:

```bash
# certify whichever model the client wants — edit `providers:` in promptfoo.yaml, then:
export ANTHROPIC_API_KEY=…            # or OPENAI_API_KEY / GOOGLE_API_KEY …
npx promptfoo@latest eval -c evals/promptfoo.yaml
npx promptfoo@latest view             # browse the results
```

To **certify a new LLM** for a client: point `providers:` at their model, run Layer 2, confirm the
rubrics pass. Your method (playbook) and your tools don't change — you just validate the engine.

## What we check (per agent-eval best practice)

- **Tool correctness** — the right tool fires with the right args (Layer 1).
- **Output correctness** — tool results match expected values (Layer 1).
- **Faithfulness / no hallucination** — the answer is grounded in tool data; declines unknown
  questions; never blames the destination; distinguishes *not-deployed* from *failing* (Layer 2).
- **Playbook adherence** — cites a correlation id, recommends (doesn't perform) fixes (Layer 2).

## Growing the suite

Add a line to `cases.jsonl` for each new scenario (new incident type, new flow, an edge case a
client hit). Layer 1 picks it up automatically; mirror the rubric into `promptfoo.yaml` for Layer 2.

## References

- promptfoo — YAML-first evals, deterministic + model-graded assertions: <https://promptfoo.dev>
- mcp-eval (lastmile-ai) — eval framework specifically for MCP servers: <https://github.com/lastmile-ai/mcp-eval>
- DeepEval — MCP + agent metrics: <https://deepeval.com/docs/evaluation-mcp>
- MCP-AgentBench / MCP-Atlas — benchmarks & LLM-as-judge patterns for MCP tool use.
