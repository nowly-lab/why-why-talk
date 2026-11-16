import { createAnswerCollector, createPendingAnswers, leaveAnswerer, readGrounding, returnsAfterAnswer, submitAfterAnswers } from "./answers.ts";
import { createApi, loadSession, toGeminiResponse, type Direction, type FileView, type Phase, type Role } from "./api.ts";
import { acceptDrop } from "./files.ts";
import { createFreeTalk } from "./free-talk.ts";
import { canStart, createLatestSaver, createTaskTracker, MAX_QUESTIONS, renderDives, renderQuestionList, selectedLabel, treeOf, type CurrentQuestion, type Dive, type Question } from "./questions.ts";
import { bytesToBase64 } from "./recorder.ts";
import { createPlayer, startMic, type Mic } from "./audio.ts";
import { createDiagLog, createLinkWatch, createStallWatch, NUDGE_TEXT } from "./diag.ts";
import { connectLive } from "./live.ts";
import { createMicController } from "./mic-input.ts";
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
  const link = createLinkWatch();
  $("topic").textContent = view.topic ?? "思うままに話してください";
  document.title = `深掘り: ${view.topic ?? "自由に話す"}`;

  let phase: Phase = view.phase;
  let questions: Question[] = view.questions;
  let dives: Dive[] = view.dives;
  let current: CurrentQuestion = view.current;
  let files: Array<FileView & { busy?: boolean; error?: string }> = [...view.files];
  // seq orders lines by when they were said (a retried segment keeps its place); lines from the server come first.
  let freeLines = view.freeTalk.map((t, i) => ({ at: Date.parse(t.at), text: t.text, seq: i - view.freeTalk.length }));
  // Free-talk audio is taken only while this is true: 問いに分ける closes it before the phase changes on the server.
  let freeOpen = true;
  const setPhase = (next: Phase) => {
    phase = next;
    document.body.dataset.phase = next;
    for (const el of document.querySelectorAll<HTMLElement>(".steps .step")) {
      if (el.dataset.step === next) el.setAttribute("aria-current", "step");
      else el.removeAttribute("aria-current");
    }
  };
  setPhase(phase);

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
  // Gemini became the answerer because the person put a question to it (not 交代して): it comes back after answering.
  let byQuestion = view.roleBy === "question";
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
  // --- free talk and files ---
  const freeLinesEl = $("free-lines");
  const fileLists = [$("file-list"), $("q-file-list")];
  const freeFailed = $("free-failed");
  const started = Date.now();
  const clock = (at: number) => {
    const s = Math.max(0, Math.round((at - (freeLines[0]?.at ?? started)) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  const renderFree = () => {
    freeLinesEl.replaceChildren(...freeLines.map((l) => {
      const row = Object.assign(document.createElement("div"), { className: "free-line" });
      row.append(Object.assign(document.createElement("time"), { textContent: clock(l.at) }), Object.assign(document.createElement("div"), { className: "said", textContent: l.text }));
      return row;
    }));
    freeLinesEl.scrollTop = freeLinesEl.scrollHeight;
  };
  const renderFiles = () => {
    $("q-files").hidden = files.length === 0;
    for (const el of fileLists) el.replaceChildren(...files.map((f) => {
      const card = Object.assign(document.createElement("div"), { className: `file${f.busy ? " busy" : ""}${f.error ? " error" : ""}` });
      card.append(
        Object.assign(document.createElement("div"), { className: "name", textContent: f.name }),
        Object.assign(document.createElement("div"), { className: "summary", textContent: f.error ?? (f.busy ? "要点を作っています…" : f.summary) }),
      );
      return card;
    }));
  };
  const freeTalk = createFreeTalk({
    postAudio: async (wav, order) => (await api.audio(wav, order)).text,
    onText: (text, seq) => {
      freeLines.push({ at: Date.now(), text, seq });
      freeLines.sort((a, b) => a.seq - b.seq);
      renderFree();
    },
    onFailedChange: (n) => {
      freeFailed.hidden = n === 0;
    },
  });
  $("free-retry").addEventListener("click", () => void freeTalk.retry());
  $("free-discard").addEventListener("click", () => {
    freeTalk.discard();
    setStatus("失敗した部分を捨てました", "idle");
  });
  const uploads = createTaskTracker();
  /**
   * Before leaving free talk or sending: wait for the last words and every file. Untranscribed words stop the step
   * until the person retries or discards them; nothing is dropped silently.
   */
  async function materialReady(): Promise<boolean> {
    const failedLeft = await freeTalk.finish();
    await uploads.settled();
    if (failedLeft > 0) {
      setStatus(`文字起こしに失敗した部分が ${failedLeft} つあります。「再試行」するか「捨てる」を選んでから進んでください`, "error");
      return false;
    }
    return true;
  }
  function addFiles(list: FileList | File[]): void {
    void uploads.track(uploadFiles(Array.from(list)));
  }
  async function uploadFiles(list: File[]): Promise<void> {
    for (const file of list) {
      const ok = acceptDrop(file);
      if (!ok.ok) {
        files.push({ name: file.name, mimeType: file.type, summary: "", error: ok.reason });
        renderFiles();
        continue;
      }
      const entry: FileView & { busy?: boolean; error?: string } = { name: file.name, mimeType: file.type, summary: "", busy: true };
      files.push(entry);
      renderFiles();
      try {
        const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
        const r = await api.file(file.name, file.type, data);
        Object.assign(entry, r.file, { busy: false });
      } catch (e) {
        Object.assign(entry, { busy: false, error: `読めませんでした: ${(e as Error).message}` });
      }
      renderFiles();
    }
  }
  const drop = $("drop");
  const fileInput = $<HTMLInputElement>("file-input");
  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files) addFiles(fileInput.files);
    fileInput.value = "";
  });
  // One handler on the body covers the drop zone too (a drop on the zone bubbles up once).
  document.body.addEventListener("dragover", (e) => {
    if (phase === "deep_dive") return;
    e.preventDefault();
    drop.classList.add("over");
  });
  document.body.addEventListener("dragleave", () => drop.classList.remove("over"));
  document.body.addEventListener("drop", (e) => {
    if (phase === "deep_dive") return;
    e.preventDefault();
    drop.classList.remove("over");
    if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
  });
  renderFree();
  renderFiles();

  // --- question list ---
  const qListEl = $("q-list");
  const startBtn = $<HTMLButtonElement>("start-dive");
  // Set while 深掘りを始める or 送信 is settling: the list cannot change under them.
  let listLocked = false;
  const renderQuestions = () => {
    renderQuestionList(qListEl, questions, { change: (next) => void saveQuestions(next) }, { locked: listLocked });
    $("q-count").textContent = `${questions.length} / ${MAX_QUESTIONS}件`;
    $("q-selected").textContent = selectedLabel(questions);
    startBtn.disabled = listLocked || !canStart(questions);
    for (const id of ["q-add", "q-resplit", "q-back"]) $<HTMLButtonElement>(id).disabled = listLocked || (id === "q-add" && questions.length >= MAX_QUESTIONS);
  };
  const lockList = (locked: boolean) => {
    listLocked = locked;
    renderQuestions();
  };
  // Saves go in edit order and only the newest answer is applied, so a slow early save cannot undo a later check.
  const questionSaver = createLatestSaver<Question[]>(async (list) => (await api.questions(list)).questions, (saved) => {
    questions = saved;
    renderQuestions();
  });
  async function saveQuestions(next: Question[]): Promise<void> {
    questions = next;
    renderQuestions();
    // A blank row is kept on screen until it has text; the server refuses empty questions.
    if (next.some((q) => q.text.trim() === "")) return;
    try {
      await questionSaver.save(next);
    } catch (e) {
      setStatus(`問いを保存できませんでした: ${(e as Error).message}`, "error");
    }
  }
  async function split(): Promise<void> {
    setStatus("話とファイルを問いに分けています…", "live");
    for (const b of [$<HTMLButtonElement>("split"), $<HTMLButtonElement>("q-resplit")]) b.disabled = true;
    const wasOpen = freeOpen;
    freeOpen = false;
    try {
      if (!(await materialReady())) {
        freeOpen = wasOpen;
        return;
      }
      questions = (await api.split()).questions;
      setPhase("questions");
      renderQuestions();
      setStatus(questions.length > 0 ? "深掘りしたい問いにチェックを入れてください" : "問いが出ませんでした。もう少し話してください", questions.length > 0 ? "idle" : "warn");
    } catch (e) {
      freeOpen = wasOpen;
      setStatus(`問いに分けられませんでした: ${(e as Error).message}`, "error");
    } finally {
      for (const b of [$<HTMLButtonElement>("split"), $<HTMLButtonElement>("q-resplit")]) b.disabled = false;
    }
  }
  $("split").addEventListener("click", () => void split());
  $("q-resplit").addEventListener("click", () => void split());
  $("q-add").addEventListener("click", () => {
    questions = [...questions, { text: "", checked: false }];
    renderQuestions();
    qListEl.querySelector<HTMLInputElement>(".q-row:last-child input[type=text]")?.focus();
  });
  $("q-back").addEventListener("click", async () => {
    try {
      await api.freeTalk();
      setPhase("free_talk");
      freeOpen = true;
      setStatus(mics.mic() ? "録音しています。Gemini は話しません" : "マイクを開始して、続きを話してください", "idle");
    } catch (e) {
      setStatus(`戻れませんでした: ${(e as Error).message}`, "error");
    }
  });
  renderQuestions();

  // --- deep dive: the question list, the current question's tree, per-question directions ---
  const divesEl = $("dives");
  const qPick = $<HTMLSelectElement>("f-question");
  const drafts = new Map<string, Direction>(view.dives.filter((d) => d.draft).map((d) => [d.questionId, d.draft!]));
  const edited = new Set<string>();
  let shownQuestion = "";
  // The tree on screen: the current question's, or one the person opened from the list.
  let viewing: string | null = null;
  const showTree = (fresh: Set<string>) => {
    const id = viewing ?? current?.questionId ?? null;
    renderTree(treeEl, id ? treeOf(tree, id) : tree, fresh);
    const d = dives.find((x) => x.questionId === id);
    $("h-tree").textContent = viewing && viewing !== current?.questionId
      ? `なぜの木(${d ? dives.indexOf(d) + 1 : ""}. を表示中 · 今の問いに戻るには一覧でもう一度押す)`
      : "なぜの木(今の問い ✓ 事実で裏付けあり / ? まだ裏付けなし)";
  };
  {
    $("dives").addEventListener("click", (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>(".dive");
      if (!card?.dataset.question) return;
      viewing = viewing === card.dataset.question || card.dataset.question === current?.questionId ? null : card.dataset.question;
      showTree(new Set());
    });
    $("dives").addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        (e.target as HTMLElement).closest<HTMLElement>(".dive")?.click();
      }
    });
  }
  const fillPick = () => {
    qPick.replaceChildren(...dives.map((d, i) => new Option(`${i + 1} ${d.text}`, d.questionId)));
    if (!shownQuestion || !dives.some((d) => d.questionId === shownQuestion)) shownQuestion = current?.questionId ?? dives[0]?.questionId ?? "";
    qPick.value = shownQuestion;
    const d = drafts.get(shownQuestion);
    if (d) fillDirection(form, d);
    else form.reset();
  };
  const renderDive = (fresh: Set<string> = new Set()) => {
    renderDives(divesEl, dives, current);
    $<HTMLButtonElement>("next-q").disabled = current === null;
    showTree(fresh);
  };
  qPick.addEventListener("change", () => {
    if (shownQuestion) drafts.set(shownQuestion, readDirection(form));
    shownQuestion = qPick.value;
    const d = drafts.get(shownQuestion);
    if (d) fillDirection(form, d);
    else form.reset();
    qPick.value = shownQuestion;
  });
  const applyDives = (v: { dives: Dive[]; current: CurrentQuestion }) => {
    const moved = v.current?.questionId !== current?.questionId;
    dives = v.dives;
    current = v.current;
    if (moved) viewing = null;
    // Follow the question being dug unless the person is writing another one's direction.
    if (moved && v.current && shownQuestion && !edited.has(shownQuestion)) {
      shownQuestion = v.current.questionId;
      fillPick();
    }
    for (const d of dives) if (d.draft && !edited.has(d.questionId)) drafts.set(d.questionId, d.draft);
    if (dives.length > 0 && qPick.options.length !== dives.length) fillPick();
    else if (!edited.has(shownQuestion) && drafts.get(shownQuestion)) fillDirection(form, drafts.get(shownQuestion)!);
    renderDive();
  };

  showTree(new Set());
  renderTranscript(transcriptEl, lines);
  renderAnswers(askedEl, view.asked);
  applyRole(view.role);
  if (dives.length > 0) {
    fillPick();
    renderDive();
  }
  if (view.status !== "talking") return finished(view.status === "sent" ? "送信済みです。このタブは閉じて構いません。" : "取りやめました。");

  // Keep the server's lease alive; a closed tab ends the talk after a grace period.
  const lease = new EventSource("/api/lease");

  setStatus(
    phase === "free_talk" ? "マイクを開始して、思うままに話してください。Gemini は黙って聞きます"
      : phase === "questions" ? "深掘りしたい問いにチェックを入れてください"
        : "マイクを開始すると、Gemini が今の問いを読み上げて質問を始めます",
    "idle",
  );
  // Started with a topic: make the list from the topic, the context and the attached files at once.
  if (phase === "questions" && questions.length === 0) void split();

  const player = createPlayer();
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
  // Which mic is chosen and which one actually feeds the talk; races between start, switches and the end live there.
  const mics = createMicController<Mic>({
    // One microphone for the whole page: free talk records it, the deep dive streams it to Gemini, the list ignores it.
    start: (id) => startMic((b64) => {
      if (phase === "free_talk" && freeOpen) freeTalk.push(b64);
      else if (phase === "deep_dive") live.sendAudio(b64);
    }, { deviceId: id, onLevel }),
    persist: (id) => {
      saveMicChoice(storage, id);
      micSelect.value = id;
    },
    onSwitchError: (e) => {
      diag.log("mic.switch_failed", e.message);
      if (mics.ended()) return;
      setStatus(`そのマイクを使えません: ${e.message}`, "error");
    },
  }, loadMicChoice(storage));
  async function refreshMics(): Promise<void> {
    try {
      const { options, selected } = micOptions(await navigator.mediaDevices.enumerateDevices(), mics.choice());
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
    link.voice(level, muted, Date.now());
    const change = silence.sample(level, muted, Date.now());
    if (change === "silent") {
      silentWarned = true;
      diag.log("mic.silent", mics.mic()?.deviceLabel());
      setStatus("マイクの音が届いていません。右のマイクの選択を確かめてください", "warn");
    } else if (change === "heard" && silentWarned) {
      diag.log("mic.heard");
      silentWarned = false;
      setStatus("話しています", "live");
    }
  };
  micSelect.addEventListener("change", async () => {
    const next = micSelect.value;
    try {
      // Before the mic has started this only remembers the choice; start applies it.
      await mics.choose(next);
      const mic = mics.mic();
      // A newer choice or the end of the talk overtook this one; that path owns the status line.
      if (!mic || mics.active() !== next) return;
      diag.log("mic.switch", mic.deviceLabel() || "default");
      setStatus(`マイクを切り替えました: ${mic.deviceLabel() || "既定のマイク"}`, "live");
    } catch (e) {
      diag.log("mic.switch_failed", (e as Error).message);
      // The talk ended while the switch was pending: keep the finished message.
      if (!mics.ended()) setStatus(`そのマイクを使えません: ${(e as Error).message}`, "error");
    }
  });

  const sendInOrder = createSerialQueue();
  const answers = createAnswerCollector();
  const pendingAnswers = createPendingAnswers((e) => api.answer(e));
  // Set while 送信 is settling: no new answer is collected, so nothing lands after the session is sent.
  let finishing = false;
  const hasHistory = view.transcript.length > 0 || view.tree.some((n) => n.parentId !== null);
  // Tool calls Gemini is waiting on; the link watch does not fire meanwhile.
  let toolsPending = 0;
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
      if (returnsAfterAnswer({ role, byQuestion }, entry)) {
        byQuestion = false;
        applyRole("interviewer");
        void api.role("interviewer").catch(() => undefined);
      }
      if (entry) {
        pendingAnswers.add(entry);
        void sendInOrder(() => pendingAnswers.flush())
          .then(() => refresh(new Set()))
          .catch((e: unknown) => setStatus(`${(e as Error).message}(送信のときにもう一度試します)`, "warn"));
      }
    },
    onToolCall: async (calls) => {
      geminiActive();
      toolsPending++;
      try {
        return await answerTools(calls);
      } finally {
        toolsPending--;
      }
    },
    onServerMessage: (content) => link.server(Date.now(), content),
    onStatus: (s, detail) => {
      diag.log(`status.${s}`, detail);
      if (s === "connected") link.server(Date.now(), false);
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
    if (finishing) return;
    // The person kept talking but nothing at all came back: the link died without closing. Resume now.
    const verdict = link.check(Date.now(), player.busy() || toolsPending > 0);
    if (verdict === "reconnect") {
      diag.log("link.stalled", `role=${role}`);
      setStatus("Gemini からの応答が止まったので、つなぎ直しています…", "warn");
      void live.reconnect();
      return;
    }
    if (verdict === "give_up") {
      // Reconnecting twice brought no reply: stop retrying on our own and let the person decide.
      diag.log("link.gave_up", `role=${role}`);
      nudgeBtn.hidden = false;
      setStatus("つなぎ直しても Gemini から応答がありません。「Gemini に呼びかけ直す」を押すか、少し待ってください", "warn");
      return;
    }
    if (!stall.check(Date.now())) return;
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

  async function answerTools(calls: { id?: string; name?: string; args?: Record<string, unknown> }[]) {
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
      if (call.name === "switch_role" && !response.error) byQuestion = call.args?.by === "question" && response.role === "answerer";
      if (typeof response.role === "string" && response.role !== role) {
        // Gemini answered a question and switches back within the same turn: record the answer before leaving.
        if (response.role === "interviewer" && role === "answerer" && !finishing && leaveAnswerer(answers, pendingAnswers)) {
          void sendInOrder(() => pendingAnswers.flush()).catch(() => undefined);
        }
        applyRole(response.role as Role);
        // Switched by voice: keep the question said in this turn; going back starts fresh.
        if (role === "interviewer") answers.reset();
      }
      out.push({ id: call.id, name: call.name, response });
    }
    // Redrawing the tree must never hold back Gemini's answer: Gemini stays silent until it gets one.
    void refresh(new Set(out.flatMap((o) => ((o.response.added as string[] | undefined) ?? [])))).catch(() => undefined);
    return out;
  }

  async function refresh(fresh: Set<string>): Promise<void> {
    const v = await loadSession();
    tree = v.tree;
    applyDives(v);
    showTree(fresh);
    renderAnswers(askedEl, v.asked);
    if (v.role !== role) {
      // The server's role changed without a tool answer we saw: keep the answer before leaving the answerer.
      if (role === "answerer" && !finishing && leaveAnswerer(answers, pendingAnswers)) {
        void sendInOrder(() => pendingAnswers.flush()).catch(() => undefined);
      }
      byQuestion = v.roleBy === "question";
      applyRole(v.role);
    }
  }

  micBtn.addEventListener("click", async () => {
    if (retryMode) {
      retryMode = false;
      micBtn.textContent = muted ? "ミュート解除" : "ミュート";
      live.retry();
      return;
    }
    const mic = mics.mic();
    if (!mic) {
      micBtn.disabled = true;
      try {
        // Both audio contexts must start inside this click (Safari): start them before awaiting anything.
        const playerReady = player.resume();
        // Falls back to the system default if the remembered mic is gone; a mic picked meanwhile is applied after.
        if (!(await mics.start())) return;
        await playerReady;
        if (mics.ended()) return;
        void refreshMics();
        micBtn.textContent = "ミュート";
        if (phase === "deep_dive") {
          await live.start();
          if (mics.ended()) return;
          roleBtn.disabled = false;
        } else {
          setStatus(phase === "free_talk" ? "録音しています。Gemini は話しません" : "マイクは開いています。問いを選んでください", "live");
        }
      } catch (e) {
        if (!mics.ended()) setStatus(`マイクを使えません: ${(e as Error).message}`, "error");
      } finally {
        // After the talk ended the page keeps every control disabled.
        if (!mics.ended()) micBtn.disabled = false;
      }
      return;
    }
    muted = !muted;
    mic.setMuted(muted);
    micBtn.textContent = muted ? "ミュート解除" : "ミュート";
    setStatus(muted ? "ミュート中" : phase === "free_talk" ? "録音しています。Gemini は話しません" : "話しています", "live");
  });

  // 深掘りを始める: the checked questions become the dives; Gemini Live connects if the mic is already open.
  startBtn.addEventListener("click", async () => {
    lockList(true);
    try {
      if (!(await materialReady())) {
        lockList(false);
        return;
      }
      // The roots come from the list the server holds: wait until every edit is saved (the list is locked meanwhile).
      await questionSaver.drain();
      applyDives(await api.diveStart());
      setPhase("deep_dive");
      fillPick();
      // The roots q1, q2, … exist only on the server until now.
      await refresh(new Set());
      if (mics.mic()) {
        await live.start();
        roleBtn.disabled = false;
      } else {
        setStatus("マイクを開始すると、Gemini が最初の問いを読み上げて質問を始めます", "idle");
      }
    } catch (e) {
      lockList(false);
      setStatus(`深掘りを始められませんでした: ${(e as Error).message}`, "error");
    }
  });

  // 次の問いへ: the person skips; this question stays 途中 and Gemini is told without a tool call.
  $("next-q").addEventListener("click", async () => {
    try {
      const v = await api.diveNext();
      applyDives(v);
      if (v.current) live.sendText(`画面から: 次の問いへ進みます(${v.current.questionId} ${v.current.text})。`);
      else live.sendText("画面から: 次の問いへ進みます。もう問いは残っていません。全部終わったことを伝えてください。");
      setStatus(v.current ? `次の問い(${v.current.questionId})に進みました` : "全部の問いが終わりました。方針を確かめて送信してください", "live");
    } catch (e) {
      setStatus(`次の問いに進めませんでした: ${(e as Error).message}`, "error");
    }
  });

  roleBtn.addEventListener("click", async () => {
    const next: Role = role === "answerer" ? "interviewer" : "answerer";
    roleBtn.disabled = true;
    try {
      await api.role(next);
      byQuestion = false;
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
    live.sendText(`ここまでをまとめて、propose_direction(question_id=${current?.questionId ?? shownQuestion}) を呼んで今の問いの方針の下書きを作ってください。要点を短く声で伝えてください。`);
    setStatus("方針を整理しています…", "live");
  });

  form.addEventListener("input", () => {
    if (shownQuestion) edited.add(shownQuestion);
  });
  form.addEventListener("change", (e) => {
    if (e.target === qPick || !shownQuestion) return;
    const d = readDirection(form);
    drafts.set(shownQuestion, d);
    void api.draft(shownQuestion, d).catch(() => undefined);
  });

  const end = () => {
    clearInterval(stallTimer);
    nudgeBtn.hidden = true;
    diag.flush();
    live.close();
    mics.stop();
    player.close();
    lease.close();
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (shownQuestion) drafts.set(shownQuestion, readDirection(form));
    const directions = Object.fromEntries([...drafts].filter(([id]) => dives.some((d) => d.questionId === id)));
    const missing = dives.find((d) => d.status === "done" && !(directions[d.questionId]?.direction ?? "").trim());
    if (missing) {
      shownQuestion = missing.questionId;
      fillPick();
      setStatus(`「${missing.text}」の方針を書いてから送信してください`, "error");
      $("f-direction").focus();
      return;
    }
    sendBtn.disabled = true;
    if (phase === "questions") lockList(true);
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
        submit: async () => {
          if (!(await materialReady())) throw new Error("文字起こしに失敗した部分があります");
          await questionSaver.drain();
          await api.submit(directions);
        },
      });
      end();
      finished("送信しました。エージェントに結果が届きます。このタブは閉じて構いません。");
    } catch (err) {
      finishing = false;
      sendBtn.disabled = false;
      if (phase === "questions") lockList(false);
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
    for (const b of [micBtn, organiseBtn, sendBtn, cancelBtn, roleBtn, $<HTMLSelectElement>("mic-select"), $<HTMLButtonElement>("split"), startBtn, $<HTMLButtonElement>("next-q"), $<HTMLButtonElement>("q-add"), $<HTMLButtonElement>("q-resplit"), $<HTMLButtonElement>("q-back"), $<HTMLButtonElement>("free-retry")]) b.disabled = true;
  }
}

void boot().catch((e: unknown) => {
  const status = document.getElementById("status");
  if (status) {
    status.textContent = `読み込めませんでした: ${(e as Error).message}`;
    status.dataset.kind = "error";
  }
});
