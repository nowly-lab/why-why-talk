---
name: why-why
description: Run a why-why (5 Whys) root-cause analysis as a branching tree with the why-why MCP tools, and review the tree with the person through the Plannotator Inbox. Use after an incident, a production error or a bug whose cause is not obvious, or when the person asks for なぜなぜ分析 / 5 Whys / root cause analysis.
---

# Why-why analysis

A single chain of "why?" misses causes that sit side by side at the same level, and it jumps over missing steps. This skill keeps the whys as a **tree**: at every level, ask why in several directions, check facts, and dig the most likely branch first while the others wait as unexplored branches.

Requires the `why-why` MCP server (tools `start_analysis` … `list_analyses`). Clef evaluation is optional.

## The loop

1. **Problem as facts.** `start_analysis` with when, where, what happened. No guessed cause, no blame.
2. **Branch.** For the node you are digging, `add_whys` with several candidates. Go through every viewpoint as a checklist:
   - 仕組み・道具 — was there a tool or mechanism that should have prevented it?
   - 人・体制 — who owned it; knowledge, handover, staffing?
   - 手順・プロセス — was there a procedure; could it be followed?
   - 検知 — why was it not noticed before or right after it happened?
   - 前提・外部 — did an external change or an unstated assumption break?
   Skip a viewpoint that has nothing real; do not invent causes to fill it.
3. **Facts.** Check logs, code, git history, metrics, docs. `add_evidence` with `supports: true` or `false`. Prefer a cheap command over reasoning.
4. **Evaluate.** `evaluate`. Answer every item in `needs_judgment` with `record_judgment` (values 0..1).
5. **Dig best first.** `next_branch`:
   - `evaluate` / `judge`: do that first.
   - `dig`: `update_node` → `digging`, then back to step 2 under that node.
   - `done`: every remaining candidate is below the threshold.
6. **Stop a branch** with `update_node`:
   - `leaf` when changing a mechanism would prevent it. The countermeasure changes a mechanism (automation, a check, monitoring), never "be careful".
   - `hypothesis` when facts cannot confirm it (reason required).
   - `rejected` when facts rule it out (reason required).
   Branches are never deleted; a rejected or hypothesis branch can return to `candidate` with a reason.
7. **Two checks before moving on.**
   - "Does this cause alone produce the parent?" If not, a sibling is missing: add it.
   - Read the chain backwards with "therefore". Where it does not follow, a step is missing: add it.

## Review with the person (Plannotator Inbox)

At each milestone (first level branched, a leaf reached, done):

1. `render`.
2. `plannotator_inbox` `send_message` in one thread per analysis:
   - `body`: one or two lines of what changed, then the `mermaid` text in a ```mermaid block.
   - `attachments`: `mermaid_path` and `html_path`. Clicking a node in the `.mmd` viewer to comment sends the node id back; the HTML shows evidence and evaluations.
   - A decision only the person can make goes in a `:::question` block.
3. End your turn; the reply arrives in this session. Apply each node comment to the node it names (add whys, evidence, change state), then continue from step 5.

When `next_branch` says `done`: `close_analysis`, render once more, and send the countermeasures as a list with their node ids.

## Rules

- Never record secrets (tokens, passwords, keys) in any text or evidence.
- A branch without supporting evidence is still a hypothesis, however plausible.
- Do not blame people; ask where the mechanism let the mistake through.
