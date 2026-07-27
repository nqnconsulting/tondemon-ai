# Playbook — the model-agnostic expertise layer

[`PLAYBOOK.md`](./PLAYBOOK.md) is the diagnostic methodology, written so it can drive **any** LLM.
It's plain instructions that reference only the MCP tool surface, so the same file works on Claude,
GPT, Gemini, Agentforce, etc. This is layer 3 of the portability stack (tools → knowledge →
**playbook** → evals).

## How to use it with each agent

- **Claude (Code/Desktop) or any MCP client:** paste `PLAYBOOK.md` as the system prompt / custom
  instructions for the project, or register it as a Claude **Skill**, alongside the
  `integration-monitor` MCP server.
- **OpenAI / GPT agents:** use `PLAYBOOK.md` as the `system` message (or the agent's instructions).
- **Agentforce:** add it as the topic/agent instructions for the action set that exposes the MCP
  tools.
- **Any framework (LangChain, Agents SDK, …):** load it as the system prompt string.

The model changes; the playbook doesn't. That's the point.

## Keeping it honest

The playbook hard-codes the rules that matter most for trust: **evidence-or-silence**, **don't
blame the destination**, **deepest failing hop owns the cause**, **not-deployed ≠ failing**, and
**always hand over a correlation id**. These are exactly what the evals in [`../evals`](../evals)
check — so when you swap in a new LLM, you can *prove* it still follows the playbook before a client
relies on it.

## Extending it (your real IP)

Add your engagement-specific judgement as a **knowledge tool** (RAG over sanitized past incidents)
and reference it from the playbook's step 5 ("Confirm"). The playbook stays portable; the knowledge
grows with every engagement.
