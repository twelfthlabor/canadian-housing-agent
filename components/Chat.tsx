"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import Icon from "./Icon";
import { cityName, money } from "./format";
import { VALUATION_FALLBACK, mdapeText, type ValuationInfo } from "./DataTable";

type ToolChip = {
  id: string;
  name: string;
  label: string;
  summary?: string;
  args?: Record<string, unknown>;
  done: boolean;
};

type ListingCard = {
  price: number;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  city: string;
  fsa: string | null;
  url?: string;
  address?: string;
  estValue: number | null;
  discountPct: number | null;
};

/** Basis line count and its priority: a search beats a snapshot, which beats a compare sum. */
type Basis = { value: number; rank: number };

type Message = {
  role: "user" | "assistant";
  content: string;
  tools: ToolChip[];
  search: { cards: ListingCard[]; total: number } | null;
  basis: Basis | null;
  cached: boolean;
  pending: boolean;
};

const SUGGESTIONS = [
  { title: "Get to know a city", question: "What is the median asking price in Ottawa?", detail: "Explore Ottawa’s asking prices", icon: "pin" },
  { title: "Compare your options", question: "Compare Hamilton and Kitchener", detail: "Hamilton or Kitchener?", icon: "compare" },
  { title: "Find room to grow", question: "Cheapest 3-bed listings in Mississauga", detail: "3-bedroom listings in Mississauga", icon: "home" },
] as const;

const ERROR_TEXT: Record<string, string> = {
  provider_error: "The answer service is temporarily unavailable. Please try again in a moment.",
  misconfigured: "This demo is not configured with an LLM provider right now.",
  rate_limited: "Too many requests. Please try again shortly.",
  budget_exhausted: "The demo has reached its daily LLM budget. Please try again tomorrow.",
};

/** "st-catharines" -> "St-Catharines" for readable tool chips. */
function displayCity(value: string): string {
  return value
    .split(/([-\s])/)
    .map((part) => (/^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join("");
}

function toolLabel(name: string, args: unknown): string {
  let suffix = "";
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (typeof record.city === "string") {
      suffix = displayCity(record.city);
    } else if (Array.isArray(record.cities)) {
      suffix = record.cities
        .filter((city): city is string => typeof city === "string")
        .map(displayCity)
        .join(", ");
    }
  }
  const friendlyName = ({ city_snapshot: "City snapshot", compare_cities: "City comparison", rank_areas: "Area ranking", search_listings: "Listing search", find_deals: "Deal finder", search_docs: "Docs search" } as Record<string, string>)[name] ?? "Sample lookup";
  return suffix ? `${friendlyName} · ${suffix}` : friendlyName;
}

const SORT_LABELS: Record<string, string> = { price_asc: "cheapest first", price_desc: "most expensive first" };
const METRIC_LABELS: Record<string, string> = { median_price: "median price", count: "listing count" };
const ORDER_LABELS: Record<string, string> = { asc: "lowest first", desc: "highest first" };

/** "st. catharines" / "st-catharines" -> "St. Catharines". */
function titleCity(value: string): string {
  return cityName(value.trim().toLowerCase().replace(/[\s.]+/g, "-"));
}

function argText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? titleCity(entry) : String(entry))).join(", ");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return value === undefined ? "—" : String(value);
}

/** A known argument reads as its value ("Toronto", "3 beds"); anything else as "key: value". */
function argNode(key: string, value: unknown): ReactNode {
  if (key === "city" && typeof value === "string") return titleCity(value);
  if (key === "fsa" && typeof value === "string") return <span className="provenance-fsa">{value.trim().toUpperCase()}</span>;
  if (key === "beds" && typeof value === "number") return `${value} ${value === 1 ? "bed" : "beds"}`;
  if (key === "bathsMin" && typeof value === "number") return `≥ ${value} ${value === 1 ? "bath" : "baths"}`;
  if ((key === "minPrice" || key === "maxPrice") && typeof value === "number") return `${key === "minPrice" ? "≥" : "≤"} ${money(value)}`;
  if (key === "minDiscount" && typeof value === "number") return `≥ ${value}% below estimate`;
  if (key === "sort" && typeof value === "string") return SORT_LABELS[value] ?? value;
  if (key === "metric" && typeof value === "string") return METRIC_LABELS[value] ?? value;
  if (key === "order" && typeof value === "string") return ORDER_LABELS[value] ?? value;
  return `${key}: ${argText(value)}`;
}

/**
 * "search_listings · Toronto · 2 beds" — the raw arguments the model sent, before server-side
 * normalisation (a full postal code appears before FSA reduction, a limit before capping).
 */
function toolCallLine(name: string, args: Record<string, unknown> | undefined): ReactNode {
  const parts: ReactNode[] = [name];
  if (args) for (const [key, value] of Object.entries(args)) parts.push(argNode(key, value));
  return parts.map((part, index) => <Fragment key={index}>{index > 0 ? " · " : ""}{part}</Fragment>);
}

function updateLastAssistant(
  messages: Message[],
  update: (message: Message) => Message,
): Message[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") {
      const next = [...messages];
      next[index] = update(next[index]);
      return next;
    }
  }
  return messages;
}

function emptyMessage(role: Message["role"]): Message {
  return { role, content: "", tools: [], search: null, basis: null, cached: false, pending: false };
}

/** Cards shown per search result, and the chat panel is narrow: keep it small. */
const CARD_LIMIT = 6;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One listing row, or null when it is too malformed to render truthfully. */
function readCard(value: unknown): ListingCard | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const price = finiteNumber(row.price);
  if (price === null || typeof row.city !== "string" || row.city === "") return null;
  const card: ListingCard = {
    price,
    beds: finiteNumber(row.beds),
    baths: finiteNumber(row.baths),
    sqft: finiteNumber(row.sqft),
    city: row.city,
    fsa: typeof row.fsa === "string" && row.fsa ? row.fsa : null,
    estValue: finiteNumber(row.estValue),
    discountPct: finiteNumber(row.discountPct),
  };
  if (typeof row.url === "string" && row.url.startsWith("https://")) card.url = row.url;
  if (typeof row.address === "string" && row.address.trim()) card.address = row.address.trim();
  return card;
}

/** Valid search_listings payload -> the cards to render; anything else -> null. */
function readSearch(data: unknown): { cards: ListingCard[]; total: number } | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.listings)) return null;
  const cards: ListingCard[] = [];
  for (const row of record.listings) {
    if (cards.length === CARD_LIMIT) break;
    const card = readCard(row);
    if (card) cards.push(card);
  }
  if (cards.length === 0) return null;
  const total = finiteNumber(record.totalMatches);
  return { cards, total: total === null || total < cards.length ? cards.length : total };
}

/** Sample size behind a tool result, for the "based on N listings" line, with its priority. */
function readCount(name: string, data: unknown): Basis | null {
  if (name === "search_listings" || name === "city_snapshot") {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const record = data as Record<string, unknown>;
    const count = finiteNumber(name === "search_listings" ? record.totalMatches : record.count);
    if (count === null || count <= 0) return null;
    return { value: count, rank: name === "search_listings" ? 2 : 1 };
  }
  if (name === "compare_cities") {
    if (!Array.isArray(data) || data.length === 0) return null;
    let sum = 0;
    for (const row of data) {
      const count = row && typeof row === "object" ? finiteNumber((row as Record<string, unknown>).count) : null;
      if (count === null) return null;
      sum += count;
    }
    return sum > 0 ? { value: sum, rank: 0 } : null;
  }
  if (name === "find_deals") {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const record = data as Record<string, unknown>;
    const count = finiteNumber(record.considered) ?? finiteNumber(record.totalMatches);
    if (count === null || count <= 0) return null;
    return { value: count, rank: 2 };
  }
  return null;
}

function cardMeta(card: ListingCard): string {
  const parts: string[] = [];
  if (card.beds !== null) parts.push(`${card.beds} bd`);
  if (card.baths !== null) parts.push(`${card.baths} ba`);
  if (card.sqft !== null) parts.push(`${card.sqft.toLocaleString("en-CA")} sqft`);
  return parts.join(" · ");
}

/** Typical error note for deal badges: city MdAPE first, overall as fallback. */
function errorNote(city: string, mdapePct: number | null, mdapeByCity: Record<string, number>): string {
  const mdape = mdapeByCity[city] ?? mdapePct;
  return typeof mdape === "number" ? `; estimates typically err by about ±${mdapeText(mdape)}%` : "";
}

/** Deal badge tooltip: exact estimate plus the typical error, city first then overall. */
function dealTooltip(city: string, estValue: number, mdapePct: number | null, mdapeByCity: Record<string, number>): string {
  return `Estimated typical asking price: ${money(estValue)}${errorNote(city, mdapePct, mdapeByCity)}`;
}

/** Screen-reader label: the visible percent, the estimate, and the same error note. */
function dealAria(city: string, estValue: number, discountPct: number, mdapePct: number | null, mdapeByCity: Record<string, number>): string {
  return `${Math.round(discountPct)}% below estimated typical asking price of ${money(estValue)}${errorNote(city, mdapePct, mdapeByCity)}`;
}

export default function Chat({ offline, draft, valuation }: { offline: boolean; draft: { text: string; id: number } | null; valuation?: Partial<ValuationInfo> }) {
  const { minDiscountPct, maxDiscountPct, mdapePct, mdapeByCity } = { ...VALUATION_FALLBACK, ...valuation };
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!draft) return;
    setInput(draft.text);
    inputRef.current?.focus();
    composerRef.current?.scrollIntoView({ block: "nearest" });
  }, [draft]);

  // Keep streamed replies visible without pulling the page away from a city
  // snapshot the visitor may be exploring at the same time.
  useEffect(() => {
    const pane = messagesRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  async function send(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;

    setInput("");
    setError(null);
    setBusy(true);

    const outgoing = [
      ...messages.map((message) => ({ role: message.role, content: message.content })),
      { role: "user" as const, content: text },
    ].slice(-20);

    setMessages((prev) => [
      ...prev,
      { ...emptyMessage("user"), content: text },
      { ...emptyMessage("assistant"), pending: true },
    ]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: outgoing }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
          retry_after_s?: number;
        } | null;
        if (data?.error === "rate_limited") {
          setError(`Rate limit reached. Try again in ${data.retry_after_s ?? 60} seconds.`);
        } else if (data?.error === "budget_exhausted") {
          setError("The demo has used its daily LLM budget. Try again tomorrow.");
        } else {
          setError("The agent could not start. Please try again.");
        }
        setMessages((prev) => [...prev.slice(0, -2), { ...emptyMessage("user"), content: text }]);
        return;
      }

      if (!response.body) throw new Error("stream missing");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleFrame = (frame: string) => {
        for (const line of frame.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>;
          } catch {
            continue;
          }

          switch (event.type) {
            case "text":
              if (typeof event.delta === "string") {
                const delta = event.delta;
                setMessages((prev) =>
                  updateLastAssistant(prev, (message) => ({
                    ...message,
                    content: message.content + delta,
                    pending: true,
                  })),
                );
              }
              break;
            case "tool": {
              const name = typeof event.name === "string" ? event.name : "tool";
              const label = toolLabel(name, event.args);
              const args =
                event.args && typeof event.args === "object" && !Array.isArray(event.args)
                  ? (event.args as Record<string, unknown>)
                  : undefined;
              setMessages((prev) =>
                updateLastAssistant(prev, (message) => ({
                  ...message,
                  tools: [
                    ...message.tools,
                    { id: `${name}-${message.tools.length}`, name, label, args, done: false },
                  ],
                })),
              );
              break;
            }
            case "tool_result": {
              const name = typeof event.name === "string" ? event.name : "";
              const search = name === "search_listings" || name === "find_deals" ? readSearch(event.data) : null;
              const basis = readCount(name, event.data);
              setMessages((prev) =>
                updateLastAssistant(prev, (message) => {
                  const tools = [...message.tools];
                  for (let index = tools.length - 1; index >= 0; index -= 1) {
                    if (!tools[index].done) {
                      tools[index] = {
                        ...tools[index],
                        done: true,
                        summary: typeof event.summary === "string" ? event.summary : undefined,
                      };
                      break;
                    }
                  }
                  return {
                    ...message,
                    tools,
                    search: search ?? message.search,
                    basis: basis && (!message.basis || basis.rank >= message.basis.rank) ? basis : message.basis,
                  };
                }),
              );
              break;
            }
            case "cached":
              setMessages((prev) => updateLastAssistant(prev, (message) => ({ ...message, cached: true })));
              break;
            case "error": {
              const code = typeof event.code === "string" ? event.code : "provider_error";
              setError(ERROR_TEXT[code] ?? ERROR_TEXT.provider_error);
              break;
            }
            case "done":
              setMessages((prev) =>
                updateLastAssistant(prev, (message) => ({ ...message, pending: false })),
              );
              break;
            default:
              break;
          }
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          handleFrame(frame);
        }
      }
      if (buffer.trim()) handleFrame(buffer);
    } catch {
      setError("Connection lost. Please try again.");
    } finally {
      setBusy(false);
      setMessages((prev) =>
        updateLastAssistant(prev, (message) => ({ ...message, pending: false })),
      );
    }
  }

  return (
    <section className="chat" aria-label="Chat with the housing agent">
      <div className="chat-heading"><span>{offline ? "Offline demo" : "Sample-based assistant"}</span><button className="new-chat" type="button" aria-label="New chat" disabled={busy || messages.length === 0} onClick={() => { setMessages([]); setInput(""); setError(null); inputRef.current?.focus(); }}><Icon name="plus" />New chat</button></div>
      {offline ? <p className="demo-notice">Scripted answers from the sample. Budget filters and follow-up questions need the live model.</p> : null}
      <div className="messages" ref={messagesRef} role="log" aria-live="polite">
        {messages.length === 0 ? <div className="chat-empty"><span className="chat-empty-mark"><Icon name="chat" /></span><h2>A closer look.</h2><p>Ask about a city’s asking prices,<br />or put two places side by side.</p></div> : null}
        {messages.map((message, index) => <div className={`msg msg-${message.role}`} key={`${message.role}-${index}`}>
          <span className="message-author">{message.role === "user" ? "You" : "Housing agent"}</span>
          {message.tools.length > 0 ? <div className="tool-chips">{message.tools.map(tool => <span className={`tool-chip${tool.done ? " done" : ""}`} key={tool.id} title={tool.summary}><span className="dot" aria-hidden="true" />{tool.label}</span>)}</div> : null}
          {message.content || message.pending ? <div className="bubble">{message.content}{message.pending && !message.content ? <span className="thinking" role="status"><span /><span /><span /><span className="sr-only">Checking the sample</span></span> : null}</div> : null}
          {message.cached ? <span className="cached-note">Cached answer</span> : null}
          {message.search ? <>
            <ul className="listing-cards" aria-label={`${message.search.cards.length} of ${message.search.total.toLocaleString("en-CA")} matching sample listings`}>
              {message.search.cards.map((card, cardIndex) => <li className="listing-card" key={cardIndex}>
                <strong className="listing-card-price">{money(card.price)}</strong>
                {card.discountPct !== null && card.estValue !== null && card.discountPct >= minDiscountPct && card.discountPct <= maxDiscountPct ? <span className="deal-badge listing-card-deal" title={dealTooltip(card.city, card.estValue, mdapePct, mdapeByCity)} aria-label={dealAria(card.city, card.estValue, card.discountPct, mdapePct, mdapeByCity)}>{Math.round(card.discountPct)}% below est.</span> : null}
                {cardMeta(card) ? <span className="listing-card-meta">{cardMeta(card)}</span> : null}
                {card.address ? <span className="listing-card-address">{card.address}</span> : null}
                <span className="listing-card-city">{card.fsa ? <span className="listing-card-fsa">{card.fsa}</span> : null}{cityName(card.city)}</span>
                {card.url ? <a href={card.url} target="_blank" rel="noopener noreferrer">View listing ↗</a> : null}
              </li>)}
            </ul>
            {message.search.total > message.search.cards.length ? <span className="listing-cards-note">Showing {message.search.cards.length} of {message.search.total.toLocaleString("en-CA")}</span> : null}
          </> : null}
          {message.basis !== null ? <p className="answer-basis">Based on {message.basis.value.toLocaleString("en-CA")} sample listings · asking prices only, not live MLS</p> : null}
          {message.tools.length > 0 ? <details className="provenance">
            <summary><Icon name="database" /><span>How this answer was computed</span><Icon name="chevron" className="provenance-chevron" /></summary>
            <div className="provenance-body">{message.tools.map((tool) => <div className="provenance-row" key={tool.id}>
              <span className="provenance-call">{toolCallLine(tool.name, tool.args)}</span>
              {tool.summary ? <span className="provenance-result">{tool.summary}</span> : null}
            </div>)}</div>
          </details> : null}
        </div>)}
      </div>
      {messages.length === 0 ? <div className="suggestions" aria-label="Suggested questions">{SUGGESTIONS.slice(0, 2).map(({ question, title, icon }) => <button className="question-suggestion" type="button" disabled={busy} key={question} onClick={() => void send(question)}><Icon name={icon} /><span>{title}</span><Icon name="arrow" /></button>)}</div> : null}
      {error ? <p className="error" ref={errorRef} role="alert">{error}</p> : null}
      <form className="composer" ref={composerRef} onSubmit={event => { event.preventDefault(); void send(input); }}>
        <label className="sr-only" htmlFor="question">Your question</label>
        <textarea ref={inputRef} autoComplete="off" id="question" rows={3} maxLength={4000} placeholder="Ask about Canadian housing…" value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(input); } }} />
        <div className="composer-bottom"><span>From the research sample</span><button type="submit" aria-label={busy ? "Thinking" : "Send question"} disabled={busy || !input.trim()}><Icon name="send" /></button></div>
      </form>
      <p className="composer-hint">Enter to send · Shift + Enter for a new line</p>
    </section>
  );
}
