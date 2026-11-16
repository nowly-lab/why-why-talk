---
name: why-why-talk
description: Draw out the person's thinking by voice. Opens a local page where the person first talks freely (and drops files), the talk is split into a question list they check, and Gemini Live digs each checked question with "why?" and "what else?", growing a why tree per question; it sends back per-question directions, reasons, rejected alternatives, open questions and trees, plus the free talk, file summaries and transcript. Use from planning (for example /planning-nowly) when the answer lives in the person's head, or when the person asks for a なぜなぜ / 壁打ち / deep dive by voice.
---

# why-why talk

One command opens a local page; the person talks, picks questions and digs them with Gemini by voice; when they press 送信 the command prints the result and exits. It works like a Plannotator plan review: you start it, then wait for the person.

The page has three steps:

1. **自由に話す (free talk):** the person talks freely. Gemini only listens (no voice); speech is transcribed a few seconds after each pause. They can drop files (text, Markdown, PDF, images).
2. **問いを選ぶ (question list):** the talk and the files become up to 10 questions. The person checks the ones worth digging and may edit, add, delete or reorder them.
3. **深掘り (deep dive):** Gemini Live digs the checked questions in list order, five whys per branch, drafts each question's direction and moves on by itself. The person can skip with 次の問いへ.

## When

- The answer lives in the person's head: why something keeps happening, which option fits, what really matters, or what they even want to decide.
- Not for questions you can settle from code, docs or a quick Inbox question.

## Topic or not

- **No topic** (the default): use it when the point itself is unclear or when several things are tangled. A fixed topic tends to steer the person away from what they actually want to talk about.
- **`--topic`**: use it only when one point is already settled. Free talk is skipped and the question list is made from the topic, `--context` and the attached files at once (the person can still go back and talk).

## Before you start

If you have material, write a context file (Markdown, keep it under a few pages) and attach files the person should see:

- what you already know: facts, logs, code findings, constraints;
- options considered so far and why each is uncertain;
- what you need back to continue the plan.

`--attach` takes text, Markdown, PDF or images, up to 10MB each, and can be repeated. Files are summarized before the page opens; only the summaries are kept. Do not put secrets in the context or the files; common token shapes are masked, but do not rely on that.

Tell the person in one line that a page is opening and what it is for.

## Run

Requires `GEMINI_API_KEY` in the environment and Node 22.18+.

```bash
npx -y github:nowly-lab/why-why-talk [--topic "<the point>"] [--context <file.md>] [--attach <file>]...
```

- **Claude Code:** run it with the Bash tool and `run_in_background: true`, `timeout: 7200000`, then end your turn. You are notified when the person sends or cancels; read the output then.
- **Codex:** run it in the foreground with the longest timeout available. It needs network access (fetching from GitHub, and the local server calls Gemini), so it may need sandbox approval.
- Options: `--out <dir>` (default `.why-why/<time>-<slug>/` in the working folder, `free-talk` without a topic), `--no-open` (print the URL only; the URL is always on stderr).

## Result

| Exit | Meaning | stdout |
| --- | --- | --- |
| 0 | The person sent it | Markdown, below, then a `files:` line |
| 1 | Cancelled, or the tab was closed for 60 s | `取りやめ (<reason>) record: <dir>` |
| 2 | Could not start (no key, bad arguments, an `--attach` file that is unsupported, missing or could not be summarized, unwritable `--out`) | message on stderr |

The Markdown starts with `# 深掘りの結果: <topic, or 問い N 件>`. Then one section per checked question, `## 問い N: <question>(<status>)`, each with 方針, 理由, 見送った案, 残った疑問, 深さ不足の枝 and なぜの木 (Mermaid + node list with each node's depth). Then 選ばなかった問い, 添付ファイルの要点, Gemini に聞いたこと, 自由に話した内容 and 深掘りの会話の全文.

Treat exit 0 with an empty or malformed body (no `# 深掘りの結果:` heading) as a failure, not as the person's answer. If no page connects within 10 minutes the command gives up with exit 1 (`画面が開かれなかった`).

## After

- Read each question by its status: **終わった** (Gemini finished it: a branch five whys deep and no shallow branch left), **途中** (the person skipped it), **掘っている途中** (sent while it was being dug), **未着手** (never reached). Only 終わった questions are guaranteed a direction; for the others, use what the tree and transcript hold and treat the rest as open.
- Fold the directions and their reasons into the plan. Quote the person's words where they decided something. Combining the questions into one conclusion is your job; the tool does not do it.
- 選ばなかった問い are what the person chose not to dig now; do not treat them as answered.
- Treat 残った疑問 as open items: answer the ones the code can answer; ask the rest in the Plannotator Inbox.
- Branches marked hypothesis are not facts; verify them before building on them.
- A leaf stopped before five whys carries the person's reason and is listed under 深さ不足の枝. Dig those further in the plan, or check that the reason holds.
- Gemini に聞いたこと holds what the person asked Gemini: after swapping roles (button or 「交代して」), or by simply putting a question to Gemini while it interviews (it answers, then goes back to digging). Those answers came from Google Search and are unverified: check them before using them.
- On 取りやめ, do not guess the outcome. The partial record in `<dir>` (free talk, questions, transcript, trees) may still help; ask the person how to proceed.
- If the person says Gemini stopped responding or misheard them, read `<dir>/events.jsonl` (connection changes, tool calls with timings, mic switches and silence, `gemini.silent`, `link.stalled`) before guessing a cause. The page lets the person pick the microphone and shows its level.
