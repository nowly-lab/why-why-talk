# why-why-talk

Talk first, then deep-dive **by voice**. An agent runs one command; a local page opens. You start by **talking freely** (Gemini only listens; your speech is transcribed a few seconds after each pause) and dropping files (text, Markdown, PDF, images). Press 問いに分ける and Gemini turns the talk and the files into a list of up to 10 questions; check the ones worth digging (edit, add, delete or reorder them first). Then **Gemini Live** interviews you on each checked question in turn: it asks "why?" to go deeper and "what else?" to go wider, grows a **why tree** per question on screen (through function calls), and once a branch is five whys deep it drafts that question's direction and moves on by itself. With `--topic`, free talk is skipped and the list is made from the topic, `--context` and the attached files at once. Ask Gemini a question while it interviews (or press 役割を交代 / say 「交代して」) about something you don't know; it answers with Google Search, goes back to digging, and those answers go to the result marked unverified. When you are done, you edit each question's direction and press 送信, and the command prints the result for the agent and exits — the same shape as a [Plannotator](https://github.com/backnotprop/plannotator) plan review.

[日本語は下にあります](#日本語)

```
agent ──why-why-talk──▶ local server (127.0.0.1) ──page + short-lived token──▶ browser ◀──voice──▶ Gemini Live
  ▲                                                                              │ tool calls grow the tree
  └──── result on stdout (per question: direction, reasons, rejected, open questions, tree; free talk, files, transcript) ◀── 送信
```

## Use

Requires Node.js 22.18+, a microphone, and `GEMINI_API_KEY` (Google AI Studio).

```bash
npx -y github:nowly-lab/why-why-talk                       # start with free talk
npx -y github:nowly-lab/why-why-talk --attach notes.pdf    # free talk, with a file already attached
npx -y github:nowly-lab/why-why-talk --topic "How do we stop payment errors from recurring?" --context notes.md
```

`--attach` can be repeated; each file is text, Markdown, PDF or an image of up to 10MB. Files are summarized, and only the summaries are kept.

| Exit | Meaning | stdout |
| --- | --- | --- |
| 0 | Sent | Result Markdown |
| 1 | Cancelled, or the tab was closed for 60 s | `取りやめ (<reason>) record: <dir>` |
| 2 | Could not start | — (message on stderr) |

The record (`result.md`, `result.json`, `tree.mmd`, `transcript.md`, `session.json`, and `events.jsonl` with connection and mic diagnostics) is written to `--out` (default `.why-why/<time>-<slug>/`). Agents: see [`skills/why-why-talk/SKILL.md`](skills/why-why-talk/SKILL.md).

| Env | Default | |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | Stays in the command; the browser only gets single-use tokens |
| `WHY_WHY_LIVE_MODEL` | `gemini-3.8-live` | The deep dive |
| `WHY_WHY_TEXT_MODEL` | `gemini-3.8-flash` | Free-talk transcription, file summaries, the question list |
| `WHY_WHY_VOICE` | `Kore` | Any Gemini voice name |
| `WHY_WHY_BROWSER` | — | `none` to never open a browser |
| `WHY_WHY_HOME` | `~/.why-why-talk` | Where running talks list themselves for `why-why-talk mcp` |

### Operate a running talk from an agent (MCP)

An agent can work a talk while the person watches the page, for example Claude filling it from a meeting transcript. Register the MCP server once:

```bash
claude mcp add why-why -- npx -y github:nowly-lab/why-why-talk mcp
```

Tools: `list_talks`, `get_talk`, `add_question` (20 questions in all), `start_dive` (the deep dive without voice: the page becomes a board the agent fills; the person starts Gemini later with マイクを開始), and Gemini's own `add_whys`, `add_fact`, `update_branch`, `propose_direction`, on **any** question. What the agent adds shows on the page at once with a 「Claude」 badge and is marked （Claude） in the result; a connected Gemini is told in one quiet line. Each running talk lists itself in `~/.why-why-talk/talks/<id>.json` (`WHY_WHY_HOME` moves it; readable by you only, removed when the talk ends) with its own agent token, separate from the page's. 「Gemini の声を消す」 silences Gemini's voice while it keeps listening.

Pick the microphone in the header (switchable mid-talk; the level meter warns when no sound arrives). If Gemini goes quiet after you spoke, 「Gemini に呼びかけ直す」 nudges it; if you keep talking and nothing at all comes back for 15 s, the page reconnects by itself. Long talks keep going: each Live connection (about 10 minutes) is renewed with a fresh token and the session-resumption handle, and if that fails the talk restarts seeded with the tree and the end of the transcript. Gemini Live pricing is roughly $0.005/min for audio in and $0.018/min out. On the free tier, Google may use what you send, including free-talk audio and attached files, to improve its products.

## Develop

```bash
npm install
npm test           # node:test on the TypeScript sources
npm run typecheck  # server and web
npm run build      # dist/ and the page bundle dist/web/
node scripts/live-smoke.ts   # real Gemini Live check (costs a few cents)
node scripts/text-smoke.ts   # real text-model check: transcription, file summaries, question list (macOS say)
```

Design: [`docs/superpowers/specs/2026-11-13-why-why-talk-design.md`](docs/superpowers/specs/2026-11-13-why-why-talk-design.md), [`docs/superpowers/specs/2026-11-16-free-talk-questions-design.md`](docs/superpowers/specs/2026-11-16-free-talk-questions-design.md). Domain model: [`docs/domain-model/`](docs/domain-model/index.html).

---

## 日本語

計画の途中で、まず思うままに話してから、出てきた問いを**声で深掘り**するための道具です。エージェントが呼び出します。

- コマンドを実行すると、手元の画面がブラウザで開きます。
- 最初は**自由に話す**段階です。Gemini は黙って聞き、話の切れ目ごとに文字起こしされます。ファイル(テキスト・Markdown・PDF・画像)もドラッグで渡せます。
- 「問いに分ける」で、話とファイルが最大 10 件の**問いのリスト**になります。深掘りしたい問いにチェックを入れます(直す・足す・消す・並べ替えるもできます)。
- 「深掘りを始める」で **Gemini Live** が聞き手になり、チェックした問いを順に「なぜ?」「他には?」と声で掘ります。問いごとに**なぜの木**が育ち、5 段に届くと Gemini が方針を下書きして次の問いへ進みます。
- 問いごとの方針を直して**送信**すると、問いごとの方針・理由・見送った案・残った疑問・木と、自由に話した内容・ファイルの要点・会話の全文がエージェントに届きます。
- `--topic` で論点を渡すと、自由に話す段階を飛ばし、論点からすぐ問いのリストを作ります。
- API キーは手元のコマンドの中だけに置き、ブラウザには使い捨ての短期トークンだけを渡します。

## License

MIT
