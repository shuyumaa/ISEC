import "./zod-jitless";
import {
  AbstractChat,
  DefaultChatTransport,
  convertFileListToFileUIParts,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ChatState,
  type ChatStatus,
  type FileUIPart,
  type UIMessage,
} from "ai";

/*
 * Admin assistant chat (vanilla AbstractChat, no framework). Everything is
 * rendered with textContent / createElement, never innerHTML, so model output
 * can't inject markup (and Trusted Types stays happy). Write tools arrive as
 * "approval-requested" tool parts and render as confirmation cards.
 */

const root = document.querySelector<HTMLElement>("[data-assistant]");

/* ------------------------------ Labels ------------------------------ */

const TOOL_LABELS: Record<string, [string, string]> = {
  search: ["Searched", "Searching"],
  listTeams: ["Looked at teams", "Looking at teams"],
  getTeam: ["Opened team", "Opening team"],
  getPlayer: ["Opened player", "Opening player"],
  listEvents: ["Looked at events", "Looking at events"],
  getEvent: ["Opened event", "Opening event"],
  getMatch: ["Opened match", "Opening match"],
  createEvent: ["Create event", ""],
  updateEvent: ["Update event", ""],
  createTeam: ["Create team", ""],
  createPlayer: ["Add player", ""],
  updatePlayer: ["Update player", ""],
  setPlayerStatus: ["Roster move", ""],
  scheduleMatch: ["Schedule match", ""],
  scheduleMatches: ["Schedule matches", ""],
  createBracket: ["Create bracket", ""],
  setMapResult: ["Set map score", ""],
  recordMapStats: ["Record player stats", ""],
  setMatchStatus: ["Set match status", ""],
};
const FIELD: Record<string, string> = {
  slug: "Record",
  matchId: "Match",
  mapIndex: "Map #",
  teamA: "Team A",
  teamB: "Team B",
  bestOf: "Best of",
  startDate: "Starts",
  endDate: "Ends",
  timeZone: "Time zone",
  prizePool: "Prize pool",
  countryCode: "Country",
  role2: "Second role",
  scoreA: "Team A rounds",
  scoreB: "Team B rounds",
};
const label = (k: string) => FIELD[k] ?? k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Minimal, safe formatting: paragraphs, "- " bullet lists, **bold**. */
function renderText(text: string) {
  const frag = document.createDocumentFragment();
  let list: HTMLUListElement | undefined;
  for (const raw of text.split(/\n/)) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      list ??= frag.appendChild(el("ul"));
      list.appendChild(inline(el("li"), bullet[1]!));
      continue;
    }
    list = undefined;
    if (line.trim()) frag.appendChild(inline(el("p"), line));
  }
  return frag;
}
function inline(target: HTMLElement, s: string) {
  s.split(/(\*\*[^*]+\*\*|`[^`]+`)/).forEach((chunk) => {
    if (/^\*\*[^*]+\*\*$/.test(chunk)) target.appendChild(el("strong", undefined, chunk.slice(2, -2)));
    else if (/^`[^`]+`$/.test(chunk)) target.appendChild(el("code", undefined, chunk.slice(1, -1)));
    else if (chunk) target.appendChild(document.createTextNode(chunk));
  });
  return target;
}

/** A tool's input as label/value rows (nested objects flattened one level). */
function inputRows(input: unknown): [string, string][] {
  if (!input || typeof input !== "object") return [];
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined || v === "") continue;
    if (k === "matches" && Array.isArray(v)) {
      for (const x of v as Record<string, unknown>[]) rows.push([String(x.stage), `${String(x.start ?? "").replace("T", " ")} · Bo${x.bestOf} · ${x.teamA ?? "TBD"} vs ${x.teamB ?? "TBD"}`]);
    } else if (k === "players" && Array.isArray(v)) {
      for (const p of v as Record<string, unknown>[]) rows.push([String(p.player), `${p.kills}–${p.deaths}${p.assists !== undefined ? `–${p.assists}` : ""}${p.adr !== undefined ? ` · ADR ${p.adr}` : ""}${p.rating !== undefined ? ` · ${p.rating}` : ""}`]);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) if (v2 !== undefined) rows.push([label(k2), v2 === null ? "—" : Array.isArray(v2) ? v2.join(", ") : String(v2)]);
    } else rows.push([label(k), Array.isArray(v) ? v.join(", ") : v === null ? "—" : String(v)]);
  }
  return rows;
}

/* ------------------------------ Chat state ------------------------------ */

class State implements ChatState<UIMessage> {
  status: ChatStatus = "ready";
  error: Error | undefined;
  messages: UIMessage[];
  constructor(
    initial: UIMessage[],
    private onChange: () => void,
  ) {
    this.messages = initial;
  }
  pushMessage = (m: UIMessage) => {
    this.messages = [...this.messages, m];
    this.onChange();
  };
  popMessage = () => {
    this.messages = this.messages.slice(0, -1);
    this.onChange();
  };
  replaceMessage = (i: number, m: UIMessage) => {
    this.messages = this.messages.map((x, j) => (j === i ? m : x));
    this.onChange();
  };
  snapshot = <T,>(x: T): T => structuredClone(x);
}

class Chat extends AbstractChat<UIMessage> {
  constructor(state: State, id: string) {
    super({
      id,
      state,
      transport: new DefaultChatTransport({ api: "/api/admin/assistant", credentials: "same-origin" }),
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      onError: () => render(),
      // Saved on the server when the answer ends: refresh the history list.
      onFinish: () => void afterTurn(),
    });
  }
  protected override setStatus(o: { status: ChatStatus; error?: Error }) {
    super.setStatus(o);
    render();
  }
}

/* ------------------------------ History ------------------------------ */

/*
 * Conversations live on the server (one list per admin). The sidebar is
 * rendered by the page and refreshed here after every answer.
 */
interface Summary {
  id: string;
  title: string;
  updatedAt: string;
}
const historyList = root?.querySelector<HTMLOListElement>(".history-list");
const historyEmpty = root?.querySelector<HTMLElement>(".history-empty");
const newId = () => crypto.randomUUID();
let chatId = new URLSearchParams(location.search).get("chat") ?? newId();

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { day: "numeric", month: "short" });
};

function historyItem(c: Summary) {
  const li = el("li", "history-item");
  li.dataset.id = c.id;
  const open = el("button", "history-open");
  open.type = "button";
  open.append(el("span", "history-title", c.title), el("time", "history-time", when(c.updatedAt)));
  (open.lastChild as HTMLTimeElement).dateTime = c.updatedAt;
  open.addEventListener("click", () => void openChat(c.id));
  const del = el("button", "history-del", "Delete");
  del.type = "button";
  del.setAttribute("aria-label", `Delete chat “${c.title}”`);
  // Two steps: the first click asks, the second deletes.
  del.addEventListener("click", async () => {
    if (!del.classList.contains("confirm")) {
      del.classList.add("confirm");
      del.textContent = "Delete?";
      setTimeout(() => {
        del.classList.remove("confirm");
        del.textContent = "Delete";
      }, 4000);
      return;
    }
    const r = await fetch(`/api/admin/chats/${encodeURIComponent(c.id)}`, { method: "DELETE" });
    if (!r.ok) return;
    if (c.id === chatId) startNew();
    await refreshHistory();
  });
  li.append(open, del);
  return li;
}

function markActive() {
  for (const li of historyList?.children ?? []) {
    const btn = li.querySelector(".history-open");
    if ((li as HTMLElement).dataset.id === chatId) btn?.setAttribute("aria-current", "true");
    else btn?.removeAttribute("aria-current");
  }
}

async function refreshHistory() {
  if (!historyList) return;
  try {
    const r = await fetch("/api/admin/chats", { headers: { Accept: "application/json" } });
    if (!r.ok) return;
    const list = (await r.json()) as Summary[];
    historyList.replaceChildren(...list.map(historyItem));
    if (historyEmpty) historyEmpty.hidden = list.length > 0;
    markActive();
  } catch {
    /* offline: keep the list we have */
  }
}

function setUrl() {
  const url = new URL(location.href);
  if (chat.messages.length) url.searchParams.set("chat", chatId);
  else url.searchParams.delete("chat");
  history.replaceState(null, "", url);
}

async function afterTurn() {
  setUrl();
  await refreshHistory();
}

function use(messages: UIMessage[], id: string) {
  void chat?.stop();
  chatId = id;
  rendered.clear();
  log?.replaceChildren();
  chat = new Chat(new State(messages, render), id);
  follow = true;
  render();
  setUrl();
  markActive();
}

function startNew() {
  use([], newId());
  input?.focus();
}

async function openChat(id: string) {
  if (id === chatId && chat.messages.length) return;
  const r = await fetch(`/api/admin/chats/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    startNew();
    return;
  }
  const c = (await r.json()) as { messages: UIMessage[] };
  use(c.messages, id);
}

/* ------------------------------ Rendering ------------------------------ */

let chat: Chat;
const log = root?.querySelector<HTMLOListElement>(".chat-log");
const scroller = root?.querySelector<HTMLElement>(".chat-scroll");
const statusLine = root?.querySelector<HTMLElement>(".chat-status");
const form = root?.querySelector<HTMLFormElement>(".composer");
const input = root?.querySelector<HTMLTextAreaElement>("#prompt");
const filesInput = root?.querySelector<HTMLInputElement>("#attach");
const preview = root?.querySelector<HTMLElement>(".attach-preview");
const sendBtn = root?.querySelector<HTMLButtonElement>(".send");
const stopBtn = root?.querySelector<HTMLButtonElement>(".stop");
const empty = root?.querySelector<HTMLElement>(".chat-empty");
const jump = root?.querySelector<HTMLButtonElement>(".jump-latest");
const approveBar = root?.querySelector<HTMLElement>(".approve-bar");

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;
const pendingApprovals = (): string[] =>
  chat.messages
    .at(-1)
    ?.parts.flatMap((p) => ("toolCallId" in p && p.state === "approval-requested" && p.approval && !p.approval.isAutomatic ? [p.approval.id] : [])) ?? [];

function toolCard(part: ToolPart) {
  const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
  const [done, doing] = TOOL_LABELS[name] ?? [name, name];
  const write = !doing;
  const state = part.state;
  if (!write) {
    // Read tools: one quiet line.
    const li = el("div", "tool-read");
    const summary = inputRows(part.input).map(([, v]) => v).join(" · ");
    li.textContent = `${state === "output-available" || state === "output-error" ? done : doing + "…"}${summary ? ` ${summary}` : ""}`;
    if (state === "output-error") li.classList.add("failed");
    return li;
  }
  const card = el("div", "tool-card");
  card.dataset.state = state;
  const head = el("div", "tool-head");
  head.appendChild(el("strong", undefined, done));
  const badge = el("span", "badge");
  const st: Record<string, [string, string]> = {
    "input-streaming": ["Preparing", ""],
    "input-available": ["Preparing", ""],
    "approval-requested": ["Needs your OK", "blue"],
    "approval-responded": [part.approval?.approved ? "Approved" : "Declined", part.approval?.approved ? "blue" : ""],
    "output-available": ["Done", "green"],
    "output-error": ["Failed", ""],
    "output-denied": ["Declined", ""],
  };
  const [text, tone] = st[state] ?? [state, ""];
  badge.textContent = text;
  if (tone) badge.classList.add(tone);
  head.appendChild(badge);
  card.appendChild(head);
  const rows = inputRows(part.input);
  if (rows.length) {
    // Long batches stay readable: the first rows, the rest behind a toggle.
    const dl = el("dl", "tool-fields");
    const add = (target: HTMLElement, [k, v]: [string, string]) => {
      const row = el("div");
      row.append(el("dt", undefined, k), el("dd", undefined, v));
      target.appendChild(row);
    };
    rows.slice(0, 8).forEach((r) => add(dl, r));
    card.appendChild(dl);
    if (rows.length > 8) {
      const more = el("details", "tool-more");
      more.appendChild(el("summary", undefined, `${rows.length - 8} more`));
      const rest = el("dl", "tool-fields");
      rows.slice(8).forEach((r) => add(rest, r));
      more.appendChild(rest);
      card.appendChild(more);
    }
  }
  if (state === "output-error" && part.errorText) card.appendChild(el("p", "tool-error", part.errorText));
  if (state === "output-available" && part.output && typeof part.output === "object" && "url" in part.output) {
    const a = el("a", undefined, "Open it");
    a.href = String((part.output as { url: string }).url);
    card.appendChild(a);
  }
  if (state === "approval-requested" && part.approval && !part.approval.isAutomatic) {
    const actions = el("div", "tool-actions");
    const ok = el("button", "btn small", "Approve");
    const no = el("button", "btn ghost small", "Decline");
    ok.type = no.type = "button";
    const id = part.approval.id;
    ok.addEventListener("click", () => void chat.addToolApprovalResponse({ id, approved: true }));
    no.addEventListener("click", () => void chat.addToolApprovalResponse({ id, approved: false, reason: "The admin declined" }));
    actions.append(ok, no);
    card.appendChild(actions);
  }
  return card;
}

function messageNode(m: UIMessage) {
  const li = el("li", `msg ${m.role}`);
  for (const part of m.parts) {
    if (part.type === "text" && part.text.trim()) {
      const box = el("div", "msg-text");
      box.appendChild(renderText(part.text));
      li.appendChild(box);
    } else if (part.type === "file" && part.mediaType.startsWith("image/")) {
      if (!part.url) li.appendChild(el("span", "msg-file", "Screenshot (not kept after reload)"));
      else {
        const img = el("img", "msg-img");
        img.src = part.url;
        img.alt = part.filename ?? "Attached screenshot";
        li.appendChild(img);
      }
    } else if ("toolCallId" in part) {
      li.appendChild(toolCard(part));
    }
  }
  return li;
}

/*
 * Follow the conversation only while the reader is at the bottom: scrolling up
 * during an answer stops the auto-scroll, and "Jump to latest" brings it back.
 * Only the log scrolls; the page never moves.
 */
let follow = true;
const atBottom = () => !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
function toBottom() {
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

// Messages are rebuilt only when their content changed (streaming touches the last one).
const rendered = new Map<string, { sig: string; node: HTMLLIElement }>();
const thinking = el("li", "msg assistant thinking");
thinking.append(el("span", "dots"), el("span", undefined, "Thinking"));

function render() {
  if (!log || !chat) return;
  const messages = chat.messages;
  const keep = new Set<string>();
  const nodes: HTMLElement[] = [];
  for (const m of messages) {
    keep.add(m.id);
    const sig = JSON.stringify(m.parts);
    let entry = rendered.get(m.id);
    if (!entry || entry.sig !== sig) {
      entry = { sig, node: messageNode(m) };
      rendered.set(m.id, entry);
    }
    if (entry.node.childElementCount) nodes.push(entry.node);
  }
  for (const id of rendered.keys()) if (!keep.has(id)) rendered.delete(id);
  const busy = chat.status === "submitted" || chat.status === "streaming";
  // "Thinking" until the answer starts arriving.
  const last = messages.at(-1);
  if (chat.status === "submitted" || (chat.status === "streaming" && last?.role === "assistant" && !last.parts.some((p) => p.type === "text" || "toolCallId" in p))) nodes.push(thinking);
  // Replace only what moved, so selection and focus in older messages survive.
  nodes.forEach((n, i) => {
    if (log.children[i] !== n) log.insertBefore(n, log.children[i] ?? null);
  });
  while (log.children.length > nodes.length) log.lastElementChild!.remove();

  if (statusLine) statusLine.textContent = chat.status === "error" ? (chat.error?.message?.replace(/^.*"error":"([^"]+)".*$/, "$1") ?? "Something went wrong.") : "";
  statusLine?.toggleAttribute("hidden", chat.status !== "error");
  if (sendBtn) sendBtn.hidden = busy;
  if (stopBtn) stopBtn.hidden = !busy;
  if (empty) empty.hidden = messages.length > 0;
  const pending = pendingApprovals();
  if (approveBar) {
    approveBar.hidden = pending.length < 2;
    const label = approveBar.querySelector(".count");
    if (label) label.textContent = `${pending.length} changes are waiting for your OK.`;
  }
  if (follow) toBottom();
  if (jump) jump.hidden = follow || atBottom();
}

function showFiles() {
  if (!preview || !filesInput) return;
  preview.replaceChildren();
  for (const f of filesInput.files ?? []) {
    const chip = el("span", "attach-chip", f.name);
    preview.appendChild(chip);
  }
  preview.hidden = !filesInput.files?.length;
}

if (root && log && form && input) {
  chat = new Chat(new State([], render), chatId);
  render();
  // Opened with ?chat=…: load that conversation from the server.
  if (new URLSearchParams(location.search).has("chat")) void openChat(chatId).catch(() => startNew());
  markActive();

  // Any upward movement is the reader taking over (wheel, touch, keys, scrollbar);
  // following resumes once they are back at the bottom. Auto-scroll only ever
  // moves down, so it can't be mistaken for the reader.
  let lastTop = scroller?.scrollTop ?? 0;
  scroller?.addEventListener(
    "scroll",
    () => {
      const top = scroller.scrollTop;
      if (top < lastTop - 1) follow = false;
      if (atBottom()) follow = true;
      lastTop = top;
      if (jump) jump.hidden = follow;
    },
    { passive: true },
  );
  scroller?.addEventListener("wheel", (e) => e.deltaY < 0 && (follow = false), { passive: true });
  jump?.addEventListener("click", () => {
    follow = true;
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    jump.hidden = true;
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const files: FileUIPart[] = filesInput?.files?.length ? await convertFileListToFileUIParts(filesInput.files) : [];
    if (!text && !files.length) return;
    input.value = "";
    if (filesInput) filesInput.value = "";
    showFiles();
    follow = true;
    void chat.sendMessage({ text: text || "Read this scoreboard.", files });
  });
  // Enter sends, Shift+Enter makes a new line. IME-safe: Enter that confirms a
  // Chinese/Japanese/Korean candidate (isComposing, or keyCode 229 in Safari) never sends.
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (e.isComposing || e.keyCode === 229) return;
    form.requestSubmit();
  });
  filesInput?.addEventListener("change", showFiles);
  stopBtn?.addEventListener("click", () => void chat.stop());
  approveBar?.querySelector(".approve-all")?.addEventListener("click", () => {
    for (const id of pendingApprovals()) void chat.addToolApprovalResponse({ id, approved: true });
  });
  approveBar?.querySelector(".decline-all")?.addEventListener("click", () => {
    for (const id of pendingApprovals()) void chat.addToolApprovalResponse({ id, approved: false, reason: "The admin declined" });
  });
  root.querySelector(".new-chat")?.addEventListener("click", startNew);
  for (const li of historyList?.querySelectorAll<HTMLLIElement>(".history-item") ?? []) {
    li.replaceWith(historyItem({ id: li.dataset.id!, title: li.querySelector(".history-title")?.textContent ?? "", updatedAt: li.querySelector("time")?.dateTime ?? "" }));
  }
  markActive();
  for (const b of root.querySelectorAll<HTMLButtonElement>("[data-suggest]")) {
    b.addEventListener("click", () => {
      input.value = b.dataset.suggest ?? "";
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
}
