# why-why-talk

Deep-dive one planning question **by voice**. An agent runs one command; a local page opens; you talk with **Gemini Live**, which plays the interviewer: it asks "why?" to go deeper and "what else?" to go wider, and grows a **why tree** on screen as you talk (through function calls). When you are done, Gemini drafts the direction, you edit it and press 送信, and the command prints the result for the agent and exits — the same shape as a [Plannotator](https://github.com/backnotprop/plannotator) plan review.

[日本語は下にあります](#日本語)

```
agent ──why-why-talk──▶ local server (127.0.0.1) ──page + short-lived token──▶ browser ◀──voice──▶ Gemini Live
  ▲                                                                              │ tool calls grow the tree
  └──────────── result on stdout (direction, reasons, rejected, open questions, tree, transcript) ◀── 送信
```

## Use

Requires Node.js 22.18+, a microphone, and `GEMINI_API_KEY` (Google AI Studio).

```bash
npx -y github:nowly-lab/why-why-talk --topic "How do we stop payment errors from recurring?" --context notes.md
```

| Exit | Meaning | stdout |
| --- | --- | --- |
| 0 | Sent | Result Markdown |
| 1 | Cancelled, or the tab was closed for 60 s | `取りやめ (<reason>) record: <dir>` |
| 2 | Could not start | — (message on stderr) |

The record (`result.md`, `result.json`, `tree.mmd`, `transcript.md`, `session.json`) is written to `--out` (default `.why-why/<time>-<slug>/`). Agents: see [`skills/why-why-talk/SKILL.md`](skills/why-why-talk/SKILL.md).

| Env | Default | |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | Stays in the command; the browser only gets single-use tokens |
| `WHY_WHY_LIVE_MODEL` | `gemini-3.8-live` | |
| `WHY_WHY_VOICE` | `Kore` | Any Gemini voice name |
| `WHY_WHY_BROWSER` | — | `none` to never open a browser |

Long talks keep going: each Live connection (about 10 minutes) is renewed with a fresh token and the session-resumption handle, and if that fails the talk restarts seeded with the tree and the end of the transcript. Gemini Live pricing is roughly $0.005/min for audio in and $0.018/min out. On the free tier, Google may use what you send to improve its products.

## Develop

```bash
npm install
npm test           # node:test on the TypeScript sources
npm run typecheck  # server and web
npm run build      # dist/ and the page bundle dist/web/
node scripts/live-smoke.ts   # real Gemini Live check (costs a few cents)
```

Design: [`docs/superpowers/specs/2026-11-13-why-why-talk-design.md`](docs/superpowers/specs/2026-11-13-why-why-talk-design.md). Domain model: [`docs/domain-model/`](docs/domain-model/index.html).

---

## 日本語

計画の途中で**一点を深掘り**したいときに、エージェントが呼び出す道具です。

- コマンドを実行すると、手元の画面がブラウザで開きます。
- **Gemini Live** が聞き手になり、「なぜ?」「他には?」と声で質問します。あなたの答えから、**なぜの木**が画面にその場で育ちます。
- 「整理する」で Gemini が方針の下書きを作ります。直して**送信**すると、方針・理由・見送った案・残った疑問・なぜの木・会話の全文がエージェントに届き、コマンドが終わります。
- API キーは手元のコマンドの中だけに置き、ブラウザには使い捨ての短期トークンだけを渡します。

## License

MIT
