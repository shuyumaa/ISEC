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
    if (k === "players" && Array.isArray(v)) {
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
  constructor(state: State) {
    super({
      state,
      transport: new DefaultChatTransport({ api: "/api/admin/assistant", credentials: "same-origin" }),
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      onError: () => render(),
    });
  }
  protected override setStatus(o: { status: ChatStatus; error?: Error }) {
    super.setStatus(o);
    render();
  }
}

/* ------------------------------ Persistence ------------------------------ */

const KEY = "isec-assistant";
function load(): UIMessage[] {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as UIMessage[];
  } catch {
    return [];
  }
}
function save(messages: UIMessage[]) {
  try {
    // Screenshots are too big to keep; the conversation text and results stay.
    const light = messages.map((m) => ({ ...m, parts: m.parts.map((p) => (p.type === "file" && p.url.length > 50_000 ? { ...p, url: "" } : p)) }));
    sessionStorage.setItem(KEY, JSON.stringify(light));
  } catch {
    /* storage full or blocked: keep the chat in memory only */
  }
}

/* ------------------------------ Rendering ------------------------------ */

let chat: Chat;
const log = root?.querySelector<HTMLOListElement>(".chat-log");
const statusLine = root?.querySelector<HTMLElement>(".chat-status");
const form = root?.querySelector<HTMLFormElement>(".composer");
const input = root?.querySelector<HTMLTextAreaElement>("#prompt");
const filesInput = root?.querySelector<HTMLInputElement>("#attach");
const preview = root?.querySelector<HTMLElement>(".attach-preview");
const sendBtn = root?.querySelector<HTMLButtonElement>(".send");
const stopBtn = root?.querySelector<HTMLButtonElement>(".stop");
const empty = root?.querySelector<HTMLElement>(".chat-empty");

function toolCard(part: Extract<UIMessage["parts"][number], { toolCallId: string }>) {
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
    "input-streaming": ["Preparing…", ""],
    "input-available": ["Preparing…", ""],
    "approval-requested": ["Needs your OK", "blue"],
    "approval-responded": [part.approval?.approved ? "Approved, running…" : "Declined", part.approval?.approved ? "blue" : ""],
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
    const dl = el("dl", "tool-fields");
    for (const [k, v] of rows) {
      const row = el("div");
      row.append(el("dt", undefined, k), el("dd", undefined, v));
      dl.appendChild(row);
    }
    card.appendChild(dl);
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

function render() {
  if (!log || !chat) return;
  const messages = chat.messages;
  save(messages);
  log.replaceChildren();
  for (const m of messages) {
    const li = el("li", `msg ${m.role}`);
    for (const part of m.parts) {
      if (part.type === "text" && part.text.trim()) {
        const box = el("div", "msg-text");
        box.appendChild(renderText(part.text));
        li.appendChild(box);
      } else if (part.type === "file" && part.mediaType.startsWith("image/")) {
        if (!part.url) li.appendChild(el("span", "msg-file muted", "Screenshot (not kept after reload)"));
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
    if (li.childElementCount) log.appendChild(li);
  }
  const busy = chat.status === "submitted" || chat.status === "streaming";
  if (statusLine) statusLine.textContent = chat.status === "submitted" ? "Thinking…" : chat.status === "error" ? (chat.error?.message?.replace(/^.*"error":"([^"]+)".*$/, "$1") ?? "Something went wrong.") : "";
  statusLine?.classList.toggle("is-error", chat.status === "error");
  if (sendBtn) sendBtn.hidden = busy;
  if (stopBtn) stopBtn.hidden = !busy;
  if (empty) empty.hidden = messages.length > 0;
  log.lastElementChild?.scrollIntoView({ block: "end", behavior: "smooth" });
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
  chat = new Chat(new State(load(), render));
  render();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const files: FileUIPart[] = filesInput?.files?.length ? await convertFileListToFileUIParts(filesInput.files) : [];
    if (!text && !files.length) return;
    input.value = "";
    if (filesInput) filesInput.value = "";
    showFiles();
    void chat.sendMessage({ text: text || "Read this scoreboard.", files });
  });
  // Enter sends, Shift+Enter makes a new line.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  filesInput?.addEventListener("change", showFiles);
  stopBtn?.addEventListener("click", () => void chat.stop());
  root.querySelector(".new-chat")?.addEventListener("click", () => {
    void chat.stop();
    chat = new Chat(new State([], render));
    render();
    input.focus();
  });
  for (const b of root.querySelectorAll<HTMLButtonElement>("[data-suggest]")) {
    b.addEventListener("click", () => {
      input.value = b.dataset.suggest ?? "";
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
}
