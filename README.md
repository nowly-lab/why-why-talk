# why-why-mcp

An MCP server for **why-why (5 Whys) root-cause analysis as a tree**. Instead of one chain of "why?", the agent asks why in several directions at every level, checks facts, and digs the most likely branch first (best-first search) while the other branches wait. Branches can be evaluated with Cloudflare's decision model **Clef**, and the tree is drawn as Mermaid and HTML to review with a person in the [Plannotator](https://github.com/backnotprop/plannotator) Inbox, whose replies come back into the agent's session.

[日本語は下にあります](#日本語)

## Install

Requires Node.js 22.18 or later.

```bash
# Claude Code
claude mcp add --scope user why-why -- npx -y github:nowly-lab/why-why-mcp
# Codex
codex mcp add why-why -- npx -y github:nowly-lab/why-why-mcp
```

The agent procedure is in [`skills/why-why/SKILL.md`](skills/why-why/SKILL.md); the server also sends a short version as MCP instructions.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | unset | Enable Clef. The token needs Workers AI permission. Without them the agent judges every question itself. |
| `WHY_WHY_CLEF_MODEL` | `clef-flash` | `clef` (more accurate) or `clef-flash` (faster). |
| `WHY_WHY_DIR` | `<cwd>/.why-why` | Where analyses (`<id>.json`) and renders (`<id>.mmd`, `<id>.html`) are stored. |
| `WHY_WHY_THRESHOLD` | `0.2` | An analysis is done when every remaining candidate's likelihood × impact is below this. |

Clef bills input tokens only ($0.24 per million at the time of writing); one evaluation of a dozen branches is well under a cent.

Whether to commit `.why-why/` is up to your project: commit it to keep the analysis with the code, or add it to `.gitignore`. Common secret shapes are masked before anything is stored, sent to Clef or drawn, but do not record secrets.

## Tools

| Tool | What it does |
| --- | --- |
| `start_analysis` | Start with the problem written as facts (node `n0`). |
| `add_whys` | Add candidate causes under a node, each with a viewpoint. |
| `add_evidence` | Record a fact that supports or argues against a node. |
| `evaluate` | Ask Clef (or return the questions for the agent) about supported / sufficient / likelihood / impact / preventable. |
| `record_judgment` | Store the agent's own answers. |
| `next_branch` | Propose the next branch to dig, best first, or say done. |
| `update_node` | digging, leaf (with countermeasure), hypothesis / rejected (with reason), or back to candidate. |
| `close_analysis` | Close when nothing is digging; returns the countermeasures. |
| `render` | Write `.mmd` and `.html` and return the Mermaid text. |
| `get_analysis`, `list_analyses` | Read. |

Branches are never deleted. Two agents writing the same analysis cannot overwrite each other: a write made from an older version is refused.

## Development

```bash
npm install
npm test          # node:test on the TypeScript sources
npm run typecheck
npm run build     # dist/
```

The domain model (event storming board, glossary, state machines, context map) is in [`docs/domain-model/`](docs/domain-model/index.html).

---

## 日本語

障害やバグの原因を、エージェントが**なぜなぜ分析**で掘るための MCP サーバーです。

- 各段で、いろいろな方向の「なぜ」を候補として出します(観点:仕組み・道具/人・体制/手順・プロセス/検知/前提・外部)。
- 事実(ログ・コード・git など)で確かめ、有力な枝から掘ります(最良優先)。掘らなかった枝も「未調査の枝」として残ります。
- 有力かどうかは、Cloudflare の決定モデル **Clef** に聞けます。設定がなければ、エージェントが判断します。
- 木は Mermaid と HTML に描かれます。Plannotator Inbox に送ると、ブラウザで木を見てノードにコメントでき、返信はエージェントのセッションに届きます。

インストールは上の `claude mcp add` / `codex mcp add` の行を実行してください。手順の詳細は [`skills/why-why/SKILL.md`](skills/why-why/SKILL.md) にあります。

## License

MIT
