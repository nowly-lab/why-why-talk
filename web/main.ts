import { createApi, loadSession, type Direction } from "./api.ts";
import { createPlayer, startMic } from "./audio.ts";
import { connectLive } from "./live.ts";
import { createSerialQueue } from "./queue.ts";
import { appendFragment, type Line } from "./transcript.ts";
import type { TreeNode } from "./tree-rows.ts";
import { fillDirection, readDirection, renderTranscript, renderTree } from "./ui.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export async function boot(): Promise<void> {
  const view = await loadSession();
  const api = createApi(view.nonce);
  $("topic").textContent = view.topic;
  document.title = `深掘り: ${view.topic}`;

  let tree: TreeNode[] = view.tree;
  let lines: Line[] = view.transcript.map((t) => ({ speaker: t.speaker, text: t.text, at: Date.parse(t.at) }));
  const treeEl = $("tree");
  const transcriptEl = $("transcript");
  const form = $<HTMLFormElement>("direction-form");
  const status = $("status");
  const micBtn = $<HTMLButtonElement>("mic");
  const organiseBtn = $<HTMLButtonElement>("organise");
  const sendBtn = $<HTMLButtonElement>("send");
  const cancelBtn = $<HTMLButtonElement>("cancel");
  const setStatus = (text: string, kind: "idle" | "live" | "warn" | "error") => {
    status.textContent = text;
    status.dataset.kind = kind;
  };
  renderTree(treeEl, tree, new Set());
  renderTranscript(transcriptEl, lines);
  if (view.draft) fillDirection(form, view.draft);
  if (view.status !== "talking") return finished(view.status === "sent" ? "送信済みです。このタブは閉じて構いません。" : "取りやめました。");

  // Keep the server's lease alive; a closed tab ends the talk after a grace period.
  const lease = new EventSource("/api/lease");

  setStatus("マイクを開始すると、Gemini が質問を始めます", "idle");

  const player = createPlayer();
  let mic: Awaited<ReturnType<typeof startMic>> | null = null;
  let muted = false;

  const sendInOrder = createSerialQueue();
  const hasHistory = view.transcript.length > 0 || view.tree.length > 1;
  const live = connectLive((fallback) => api.token(fallback), {
    onAudio: (b64) => player.play(b64),
    onInterrupted: () => player.interrupt(),
    onTranscript: (speaker, text) => {
      lines = appendFragment(lines, speaker, text, Date.now());
      renderTranscript(transcriptEl, lines);
      void sendInOrder(() => api.transcript(speaker, text)).catch(() => undefined);
    },
    onToolCall: async (calls) => {
      const out = [];
      for (const call of calls) {
        let response: Record<string, unknown>;
        try {
          const r = await api.tool(call.name ?? "", call.args ?? {});
          response = r.ok ? { result: "ok", added: r.added ?? [], note: r.note, tree: r.tree } : { error: r.error, tree: r.tree };
        } catch (e) {
          response = { error: (e as Error).message };
        }
        out.push({ id: call.id, name: call.name, response });
      }
      await refresh(new Set(out.flatMap((o) => ((o.response.added as string[] | undefined) ?? []))));
      return out;
    },
    onStatus: (s, detail) => {
      if (s === "connected") setStatus(muted ? "ミュート中" : "話しています", "live");
      else if (s === "connecting") setStatus("Gemini につないでいます…", "idle");
      else if (s === "reconnecting") setStatus("つなぎ直しています…", "warn");
      else if (s === "error") setStatus(`接続のエラー: ${detail ?? ""}`, "error");
      else if (s === "failed") {
        setStatus(`つなげませんでした: ${detail ?? ""}`, "error");
        micBtn.textContent = "つなぎ直す";
        retryMode = true;
      }
      else setStatus("会話を止めました", "idle");
    },
  }, { hasHistory });
  let retryMode = false;

  async function refresh(fresh: Set<string>): Promise<void> {
    const v = await loadSession();
    tree = v.tree;
    renderTree(treeEl, tree, fresh);
    if (v.draft && !form.dataset.edited) fillDirection(form, v.draft);
  }

  micBtn.addEventListener("click", async () => {
    if (retryMode) {
      retryMode = false;
      micBtn.textContent = muted ? "ミュート解除" : "ミュート";
      live.retry();
      return;
    }
    if (!mic) {
      micBtn.disabled = true;
      try {
        await player.resume();
        mic = await startMic((b64) => live.sendAudio(b64));
        await live.start();
        micBtn.textContent = "ミュート";
      } catch (e) {
        setStatus(`マイクを使えません: ${(e as Error).message}`, "error");
        mic = null;
      } finally {
        micBtn.disabled = false;
      }
      return;
    }
    muted = !muted;
    mic.setMuted(muted);
    micBtn.textContent = muted ? "ミュート解除" : "ミュート";
    setStatus(muted ? "ミュート中" : "話しています", "live");
  });

  organiseBtn.addEventListener("click", () => {
    live.sendText("ここまでをまとめて、propose_direction を呼んで方針の下書きを作ってください。要点を短く声で伝えてください。");
    setStatus("方針を整理しています…", "live");
  });

  form.addEventListener("input", () => {
    form.dataset.edited = "1";
  });
  form.addEventListener("change", () => void api.draft(readDirection(form)).catch(() => undefined));

  const end = () => {
    live.close();
    mic?.stop();
    player.close();
    lease.close();
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d: Direction = readDirection(form);
    if (d.direction.trim() === "") {
      setStatus("方針の欄を書いてから送信してください", "error");
      $("f-direction").focus();
      return;
    }
    sendBtn.disabled = true;
    try {
      await api.submit(d);
      end();
      finished("送信しました。エージェントに結果が届きます。このタブは閉じて構いません。");
    } catch (err) {
      sendBtn.disabled = false;
      setStatus(`送信できませんでした: ${(err as Error).message}`, "error");
    }
  });

  cancelBtn.addEventListener("click", async () => {
    try {
      await api.cancel();
    } finally {
      end();
      finished("取りやめました。エージェントには「取りやめ」と伝わります。");
    }
  });

  function finished(message: string): void {
    document.body.dataset.done = "1";
    setStatus(message, "idle");
    for (const b of [micBtn, organiseBtn, sendBtn, cancelBtn]) b.disabled = true;
  }
}

void boot().catch((e: unknown) => {
  const status = document.getElementById("status");
  if (status) {
    status.textContent = `読み込めませんでした: ${(e as Error).message}`;
    status.dataset.kind = "error";
  }
});
