import { createAnswerCollector, createPendingAnswers, readGrounding, submitAfterAnswers } from "./answers.ts";
import { createApi, loadSession, toGeminiResponse, type Direction, type Role } from "./api.ts";
import { createPlayer, startMic, type Mic } from "./audio.ts";
import { createDiagLog, createStallWatch, NUDGE_TEXT } from "./diag.ts";
import { connectLive } from "./live.ts";
import { createSilenceWatch, loadMicChoice, meterValue, micOptions, saveMicChoice } from "./mic.ts";
import { createSerialQueue } from "./queue.ts";
import { appendFragment, type Line } from "./transcript.ts";
import type { TreeNode } from "./tree-rows.ts";
import { fillDirection, readDirection, renderAnswers, renderTranscript, renderTree } from "./ui.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export async function boot(): Promise<void> {
  const view = await loadSession();
  const api = createApi(view.nonce);
  const diag = createDiagLog((events) => api.log(events));
  const stall = createStallWatch();
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
  const roleBtn = $<HTMLButtonElement>("role-btn");
  const roleBadge = $("role");
  const askedEl = $("asked");
  let role: Role = view.role;
  const applyRole = (next: Role) => {
    role = next;
    roleBadge.dataset.role = next;
    roleBadge.textContent = next === "answerer" ? "Gemini: 答える係" : "Gemini: 聞き手";
    roleBtn.textContent = next === "answerer" ? "聞き手に戻す" : "役割を交代";
  };
  const setStatus = (text: string, kind: "idle" | "live" | "warn" | "error") => {
    status.textContent = text;
    status.dataset.kind = kind;
  };
  renderTree(treeEl, tree, new Set());
  renderTranscript(transcriptEl, lines);
  renderAnswers(askedEl, view.asked);
  applyRole(view.role);
  if (view.draft) fillDirection(form, view.draft);
  if (view.status !== "talking") return finished(view.status === "sent" ? "送信済みです。このタブは閉じて構いません。" : "取りやめました。");

  // Keep the server's lease alive; a closed tab ends the talk after a grace period.
  const lease = new EventSource("/api/lease");

  setStatus("マイクを開始すると、Gemini が質問を始めます", "idle");

  const player = createPlayer();
  let mic: Mic | null = null;
  let muted = false;

  // Microphone choice ("" = system default), remembered per browser; switchable mid-talk without reconnecting.
  const micSelect = $<HTMLSelectElement>("mic-select");
  const micLevel = $<HTMLMeterElement>("mic-level");
  const storage = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();
  let micChoice = loadMicChoice(storage);
  async function refreshMics(): Promise<void> {
    try {
      const { options, selected } = micOptions(await navigator.mediaDevices.enumerateDevices(), micChoice);
      micSelect.replaceChildren(...options.map((o) => new Option(o.label, o.id, false, o.id === selected)));
      micSelect.value = selected;
    } catch {
      // No device list (old browser): keep the single default entry.
    }
  }
  void refreshMics();
  navigator.mediaDevices?.addEventListener?.("devicechange", () => void refreshMics());
  const silence = createSilenceWatch();
  let silentWarned = false;
  const onLevel = (level: number) => {
    micLevel.value = meterValue(level);
    const change = silence.sample(level, muted, Date.now());
    if (change === "silent") {
      silentWarned = true;
      diag.log("mic.silent", mic?.deviceLabel());
      setStatus("マイクの音が届いていません。右のマイクの選択を確かめてください", "warn");
    } else if (change === "heard" && silentWarned) {
      diag.log("mic.heard");
      silentWarned = false;
      setStatus("話しています", "live");
    }
  };
  micSelect.addEventListener("change", async () => {
    const next = micSelect.value;
    const previous = micChoice;
    micChoice = next;
    saveMicChoice(storage, next);
    if (!mic) return;
    micSelect.disabled = true;
    try {
      await mic.switchDevice(next);
      diag.log("mic.switch", mic.deviceLabel() || "default");
      setStatus(`マイクを切り替えました: ${mic.deviceLabel() || "既定のマイク"}`, "live");
    } catch (e) {
      micChoice = previous;
      micSelect.value = previous;
      saveMicChoice(storage, previous);
      setStatus(`そのマイクを使えません: ${(e as Error).message}`, "error");
      diag.log("mic.switch_failed", (e as Error).message);
    } finally {
      micSelect.disabled = false;
    }
  });

  const sendInOrder = createSerialQueue();
  const answers = createAnswerCollector();
  const pendingAnswers = createPendingAnswers((e) => api.answer(e));
  // Set while 送信 is settling: no new answer is collected, so nothing lands after the session is sent.
  let finishing = false;
  const hasHistory = view.transcript.length > 0 || view.tree.length > 1;
  const live = connectLive((fallback) => api.token(fallback), {
    onAudio: (b64) => {
      geminiActive();
      player.play(b64);
    },
    onInterrupted: () => {
      diag.log("interrupted");
      player.interrupt();
      answers.interrupted();
    },
    onTranscript: (speaker, text) => {
      if (speaker === "person") stall.person(Date.now());
      else geminiActive();
      lines = appendFragment(lines, speaker, text, Date.now());
      renderTranscript(transcriptEl, lines);
      void sendInOrder(() => api.transcript(speaker, text)).catch(() => undefined);
      // The person's words are kept in every role, so a question said together with 「交代して」 is not lost.
      if (finishing) return;
      if (speaker === "person") answers.person(text);
      else if (role === "answerer") answers.gemini(text);
      else answers.otherTurn();
    },
    onGrounding: (meta) => {
      if (role === "answerer" && !finishing) answers.grounding(readGrounding(meta));
    },
    onTurnComplete: () => {
      geminiActive();
      diag.log("turn_complete");
      if (finishing) return;
      if (role !== "answerer") {
        answers.otherTurn();
        return;
      }
      const entry = answers.turnComplete();
      if (entry) {
        pendingAnswers.add(entry);
        void sendInOrder(() => pendingAnswers.flush())
          .then(() => refresh(new Set()))
          .catch((e: unknown) => setStatus(`${(e as Error).message}(送信のときにもう一度試します)`, "warn"));
      }
    },
    onToolCall: async (calls) => {
      geminiActive();
      const out = [];
      for (const call of calls) {
        let response: Record<string, unknown>;
        const started = performance.now();
        try {
          const r = await api.tool(call.name ?? "", call.args ?? {});
          response = toGeminiResponse(r);
        } catch (e) {
          response = { error: (e as Error).message };
        }
        diag.log(response.error ? "tool.error" : "tool", `${call.name ?? "?"}${response.error ? `: ${String(response.error)}` : ""}`, performance.now() - started);
        if (typeof response.role === "string" && response.role !== role) {
          applyRole(response.role as Role);
          // Switched by voice: keep the question said in this turn; going back forgets the answerer's turn.
          if (role === "interviewer") answers.reset();
        }
        out.push({ id: call.id, name: call.name, response });
      }
      // Redrawing the tree must never hold back Gemini's answer: Gemini stays silent until it gets one.
      void refresh(new Set(out.flatMap((o) => ((o.response.added as string[] | undefined) ?? [])))).catch(() => undefined);
      return out;
    },
    onStatus: (s, detail) => {
      diag.log(`status.${s}`, detail);
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

  // Gemini went quiet after the person spoke: log it and offer a button that calls Gemini back.
  const nudgeBtn = $<HTMLButtonElement>("nudge");
  function geminiActive(): void {
    stall.gemini(Date.now());
    nudgeBtn.hidden = true;
  }
  const stallTimer = setInterval(() => {
    if (finishing || !stall.check(Date.now())) return;
    diag.log("gemini.silent", `role=${role}`);
    nudgeBtn.hidden = false;
    setStatus("Gemini が黙っています。「Gemini に呼びかけ直す」を押してください", "warn");
  }, 1_000);
  nudgeBtn.addEventListener("click", () => {
    diag.log("nudge");
    nudgeBtn.hidden = true;
    live.sendText(NUDGE_TEXT);
    setStatus("Gemini に呼びかけ直しました", "live");
  });

  async function refresh(fresh: Set<string>): Promise<void> {
    const v = await loadSession();
    tree = v.tree;
    renderTree(treeEl, tree, fresh);
    renderAnswers(askedEl, v.asked);
    if (v.role !== role) applyRole(v.role);
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
        // Both audio contexts must start inside this click (Safari): start them before awaiting anything.
        const playerReady = player.resume();
        mic = await startMic((b64) => live.sendAudio(b64), { deviceId: micChoice, onLevel }).catch((e: unknown) => {
          // A remembered mic that was unplugged: fall back to the system default instead of failing.
          if (!micChoice) throw e;
          micChoice = "";
          saveMicChoice(storage, "");
          return startMic((b64) => live.sendAudio(b64), { deviceId: "", onLevel });
        });
        void refreshMics();
        await playerReady;
        await live.start();
        micBtn.textContent = "ミュート";
        roleBtn.disabled = false;
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

  roleBtn.addEventListener("click", async () => {
    const next: Role = role === "answerer" ? "interviewer" : "answerer";
    roleBtn.disabled = true;
    try {
      await api.role(next);
      applyRole(next);
      answers.reset();
      live.sendText(next === "answerer"
        ? "役割を交代します。ここからあなたは答える係です。私の質問に、Google 検索で確かめてから短く答えてください。木の関数は呼ばないでください。"
        : "役割を交代します。聞き手に戻ってください。直前に掘っていた枝の続きから、なぜを聞いてください。");
    } catch (e) {
      setStatus(`役割を変えられませんでした: ${(e as Error).message}`, "error");
    } finally {
      roleBtn.disabled = false;
    }
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
    clearInterval(stallTimer);
    nudgeBtn.hidden = true;
    diag.flush();
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
      // Freeze collection, record the answer heard so far, then submit behind every queued write.
      await submitAfterAnswers({
        queue: sendInOrder,
        collector: answers,
        answering: role === "answerer",
        freeze: () => {
          finishing = true;
        },
        pending: pendingAnswers,
        submit: () => api.submit(d),
      });
      end();
      finished("送信しました。エージェントに結果が届きます。このタブは閉じて構いません。");
    } catch (err) {
      finishing = false;
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
    for (const b of [micBtn, organiseBtn, sendBtn, cancelBtn, roleBtn, $<HTMLSelectElement>("mic-select")]) b.disabled = true;
  }
}

void boot().catch((e: unknown) => {
  const status = document.getElementById("status");
  if (status) {
    status.textContent = `読み込めませんでした: ${(e as Error).message}`;
    status.dataset.kind = "error";
  }
});
