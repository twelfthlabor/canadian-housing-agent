import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { BudgetExhaustedError, errorEventFrom, runAgent, sseEvent } from "@/lib/agent";
import type { AgentErrorCode, AgentEvent, AgentInputMessage } from "@/lib/agent";
import {
  checkBudget,
  consumeLlmCall,
  firstHopIp,
  getCachedAnswer,
  putCachedAnswer,
  sharedGuardState,
  takeRateLimit,
} from "@/lib/guards";
import type { CachedDisplayEvent } from "@/lib/guards";
import { traceChatTurn } from "@/lib/langfuse";
import { logEvent } from "@/lib/observability";
import { getProvider } from "@/lib/providers";
import { TOOL_SPECS } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tool names the model is allowed to call; keeps arbitrary model text out of traces. */
const KNOWN_TOOL_NAMES = new Set(TOOL_SPECS.map((spec) => spec.function.name));

type IncomingBody = { messages?: unknown };

function sanitizeMessages(input: unknown): AgentInputMessage[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (item): item is { role: "user" | "assistant"; content: string } =>
        Boolean(item) &&
        typeof item === "object" &&
        (item as { role?: unknown }).role !== undefined &&
        ((item as { role?: unknown }).role === "user" ||
          (item as { role?: unknown }).role === "assistant") &&
        typeof (item as { content?: unknown }).content === "string",
    )
    .map((item) => ({ role: item.role, content: item.content.slice(0, 4_000) }))
    .slice(-20);
}

/** Same-origin only: an absent Origin is fine, a mismatched one is not. */
function originMatches(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("host") ?? request.nextUrl.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  if (!originMatches(request)) {
    return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  }

  const mediaType = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }

  let body: IncomingBody;
  try {
    body = (await request.json()) as IncomingBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const messages = sanitizeMessages(body?.messages);
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "messages_required" }, { status: 400 });
  }

  const guards = sharedGuardState();
  const ip = firstHopIp(
    request.headers.get("x-vercel-forwarded-for"),
    request.headers.get("x-forwarded-for"),
  );
  const rate = takeRateLimit(guards, ip);
  if (!rate.allowed) {
    logEvent({ event: "rate_limited", reason: "rate_limited" });
    return NextResponse.json(
      { error: "rate_limited", retry_after_s: rate.retryAfterS },
      { status: 429 },
    );
  }
  // Follow-ups depend on history; a last-question-only key cannot represent it.
  const question = messages[messages.length - 1].content;
  const cacheable = messages.length === 1;
  const cached = cacheable ? getCachedAnswer(guards, question) : null;
  if (cached === null && !checkBudget(guards).allowed) {
    logEvent({
      event: "chat_turn",
      durationMs: Date.now() - startedAt,
      cached: false,
      tools: [],
      errorCode: "budget_exhausted",
    });
    return NextResponse.json({ error: "budget_exhausted" }, { status: 503 });
  }

  const provider = getProvider();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const toolNames: string[] = [];
      const toolSpans: { name: string; startMs: number; endMs: number }[] = [];
      const toolStarts = new Map<string, number>();
      const send = (event: AgentEvent) => {
        if (event.type === "tool" && !toolNames.includes(event.name)) {
          toolNames.push(event.name);
        }
        controller.enqueue(encoder.encode(sseEvent(event)));
      };

      let answer = "";
      let completed = false;
      let failed = false;
      let errorCode: AgentErrorCode | undefined;
      // Replayed on a cache hit so the UI keeps cards, the "Based on N" line, and tool chips.
      const displayEvents: CachedDisplayEvent[] = [];
      try {
        if (cached !== null) {
          send({ type: "cached" });
          for (const event of cached.events) send(event);
          send({ type: "text", delta: cached.answer });
          send({ type: "done" });
        } else {
          for await (const event of runAgent({
            messages,
            provider,
            signal: request.signal,
            beforeLlmCall: () => {
              const decision = consumeLlmCall(guards);
              if (!decision.allowed) throw new BudgetExhaustedError();
            },
          })) {
            if (event.type === "text") answer += event.delta;
            if (event.type === "tool") toolStarts.set(event.name, Date.now());
            if (event.type === "tool_result") {
              const startMs = toolStarts.get(event.name);
              if (startMs !== undefined) {
                toolStarts.delete(event.name);
                toolSpans.push({ name: event.name, startMs, endMs: Date.now() });
              }
            }
            if (event.type === "tool" || event.type === "tool_result") displayEvents.push(event);
            if (event.type === "done") completed = true;
            if (event.type === "error") {
              failed = true;
              errorCode = event.code;
            }
            send(event);
          }
          if (cacheable && completed && !failed && !request.signal.aborted && answer.trim()) {
            putCachedAnswer(guards, question, answer.trim(), displayEvents);
          }
        }
      } catch (error) {
        const event = errorEventFrom(error);
        errorCode = event.code;
        send(event);
      } finally {
        try {
          controller.close();
        } catch {
          // Stream already closed.
        }
        // One metadata-only line per turn; never message content or headers.
        const durationMs = Date.now() - startedAt;
        logEvent({
          event: "chat_turn",
          durationMs,
          cached: cached !== null,
          tools: toolNames,
          errorCode,
        });
        traceChatTurn({
          durationMs,
          cached: cached !== null,
          tools: toolNames.filter((name) => KNOWN_TOOL_NAMES.has(name)),
          errorCode,
          toolSpans: toolSpans.filter((span) => KNOWN_TOOL_NAMES.has(span.name)),
        });
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
