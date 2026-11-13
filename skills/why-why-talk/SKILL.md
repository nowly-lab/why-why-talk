---
name: why-why-talk
description: Deep-dive one planning point by voice. Opens a local page where the person talks with Gemini Live, which asks "why?" and "what else?", grows a why tree, and sends back the direction, reasons, rejected alternatives, open questions, tree and full transcript. Use from planning (for example /planning-nowly) when one decision or root cause needs the person's thinking drawn out, or when the person asks for a なぜなぜ / 壁打ち / deep dive by voice.
---

# why-why talk

One command opens a local page; the person talks with Gemini by voice; when they press 送信 the command prints the result and exits. It works like a Plannotator plan review: you start it, then wait for the person.

## When

- A planning point where the answer lives in the person's head: why something keeps happening, which option fits, what really matters.
- Not for questions you can settle from code, docs or a quick Inbox question.

## Before you start

Write the context file the person and Gemini will work from (Markdown, keep it under a few pages):

- the point in one sentence (this also goes in `--topic`);
- what you already know: facts, logs, code findings, constraints;
- options considered so far and why each is uncertain;
- what you need back to continue the plan.

Do not put secrets in it; common token shapes are masked, but do not rely on that.

Tell the person in one line that a page is opening and what the point is.

## Run

Requires `GEMINI_API_KEY` in the environment and Node 22.18+.

```bash
npx -y github:nowly-lab/why-why-talk --topic "<the point>" --context <file.md>
```

- **Claude Code:** run it with the Bash tool and `run_in_background: true`, `timeout: 7200000`, then end your turn. You are notified when the person sends or cancels; read the output then.
- **Codex:** run it in the foreground with the longest timeout available.
- Options: `--out <dir>` (default `.why-why/<time>-<slug>/` in the working folder), `--no-open` (print the URL only; the URL is always on stderr).

## Result

| Exit | Meaning | stdout |
| --- | --- | --- |
| 0 | The person sent it | Markdown: 方針, 理由, 見送った案, 残った疑問, なぜの木 (Mermaid + node list), 会話の全文, then a `files:` line |
| 1 | Cancelled, or the tab was closed for 60 s | `取りやめ (<reason>) record: <dir>` |
| 2 | Could not start (no key, bad arguments) | message on stderr |

## After

- Fold the direction and its reasons into the plan. Quote the person's words where they decided something.
- Treat 残った疑問 as open items: answer the ones the code can answer; ask the rest in the Plannotator Inbox.
- Branches marked hypothesis are not facts; verify them before building on them.
- On 取りやめ, do not guess the outcome. The partial record in `<dir>` (transcript, tree) may still help; ask the person how to proceed.
