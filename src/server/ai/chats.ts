import type { UIMessage } from "ai";
import { findDocs, readDoc, transaction } from "../db";
import { FormError } from "../forms";

/*
 * Assistant conversations, kept on the server per admin account. Only the
 * owner can list, open or delete them. Screenshots are dropped before saving
 * (too big, and they don't need to live on); the text, tool calls and their
 * results stay, so a chat can be picked up again later.
 */

export interface Chat {
  id: string;
  owner: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: UIMessage[];
}
export type ChatSummary = Pick<Chat, "id" | "title" | "updatedAt">;

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_MESSAGES = 200;
const MAX_CHATS = 100;
export const isChatId = (id: unknown): id is string => typeof id === "string" && ID.test(id);

function titleOf(messages: UIMessage[]) {
  const first = messages.find((m) => m.role === "user")?.parts.find((p) => p.type === "text");
  const t = first && "text" in first ? first.text.replace(/\s+/g, " ").trim() : "";
  return (t.length > 60 ? `${t.slice(0, 57)}…` : t) || "Screenshot";
}

const light = (messages: UIMessage[]) =>
  messages.slice(-MAX_MESSAGES).map((m) => ({ ...m, parts: m.parts.map((p) => (p.type === "file" && p.url.startsWith("data:") ? { ...p, url: "" } : p)) }));

export const listChats = (owner: string): ChatSummary[] =>
  findDocs<Chat>("chat", "owner", owner)
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export function getChat(id: string, owner: string) {
  const c = isChatId(id) ? readDoc<Chat>("chat", id) : undefined;
  return c && c.owner === owner ? c : undefined;
}

export function saveChat(id: string, owner: string, messages: UIMessage[]) {
  if (!isChatId(id)) throw new FormError("Bad chat id.");
  const existing = readDoc<Chat>("chat", id);
  if (existing && existing.owner !== owner) throw new FormError("That chat belongs to someone else.");
  const now = new Date().toISOString();
  const chat: Chat = { id, owner, title: existing?.title || titleOf(messages), createdAt: existing?.createdAt ?? now, updatedAt: now, messages: light(messages) };
  transaction(
    (tx) => {
      tx.put("chat", id, chat);
      // Keep each admin's newest chats only.
      if (!existing) for (const old of listChats(owner).slice(MAX_CHATS - 1)) if (old.id !== id) tx.remove("chat", old.id);
    },
    owner,
    "save chat",
    { audit: false, broadcast: false },
  );
  return chat;
}

export function renameChat(id: string, owner: string, title: string) {
  const c = getChat(id, owner);
  if (!c) throw new FormError("That chat no longer exists.");
  const t = title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!t) throw new FormError("Give the chat a name.");
  transaction((tx) => tx.put("chat", id, { ...c, title: t }), owner, "rename chat", { audit: false, broadcast: false });
}

export function deleteChat(id: string, owner: string) {
  if (!getChat(id, owner)) throw new FormError("That chat no longer exists.");
  transaction((tx) => tx.remove("chat", id), owner, "delete chat", { audit: false, broadcast: false });
}
