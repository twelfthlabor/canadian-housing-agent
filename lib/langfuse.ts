/**
 * Optional Langfuse tracing for chat turns. Metadata only: durations, cache
 * status, tool names, and stable error codes. Message content, tool arguments,
 * queries, keys, and IPs never leave the process. The SDK is imported lazily
 * and every failure is swallowed, so tracing can never affect a request.
 */

type ChatToolSpan = { name: string; startMs: number; endMs: number };

type ChatTurnTrace = {
  durationMs: number;
  cached: boolean;
  tools: string[];
  errorCode?: string;
  toolSpans?: ChatToolSpan[];
};

/** The only SDK surface used here, so tests can inject a plain object. */
type ClientLike = {
  trace: (body: { name: string; metadata: Record<string, unknown> }) => {
    span: (body: {
      name: string;
      startTime: Date;
      endTime: Date;
      metadata: Record<string, unknown>;
    }) => unknown;
  };
  flushAsync: () => Promise<unknown>;
};

let clientFactory: null | (() => unknown) = null;
let client: ClientLike | null = null;
let loading: Promise<ClientLike> | null = null;

/**
 * Test-only seam: inject a fake client so tests never load the SDK or touch
 * the network. Pass null to restore lazy real-client behavior.
 */
export function __setClientFactory(factory: null | (() => unknown)): void {
  clientFactory = factory;
  client = null;
  loading = null;
}

function emit(target: ClientLike, turn: ChatTurnTrace): void {
  const metadata: Record<string, unknown> = {
    durationMs: turn.durationMs,
    cached: turn.cached,
    tools: turn.tools,
  };
  if (turn.errorCode !== undefined) metadata.errorCode = turn.errorCode;

  const trace = target.trace({ name: "chat_turn", metadata });
  for (const span of turn.toolSpans ?? []) {
    trace.span({
      name: `tool:${span.name}`,
      startTime: new Date(span.startMs),
      endTime: new Date(span.endMs),
      metadata: { durationMs: span.endMs - span.startMs },
    });
  }
  void Promise.resolve(target.flushAsync()).catch(() => {});
}

export function traceChatTurn(turn: ChatTurnTrace): void {
  try {
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    if (!publicKey || !secretKey) return;

    if (clientFactory) {
      client ??= clientFactory() as ClientLike;
      emit(client, turn);
      return;
    }
    if (client) {
      emit(client, turn);
      return;
    }
    const pending =
      loading ??
      import("langfuse").then(({ Langfuse }) => {
        client = new Langfuse({
          publicKey,
          secretKey,
          baseUrl: process.env.LANGFUSE_BASE_URL,
        }) as unknown as ClientLike;
        return client;
      });
    loading = pending;
    void pending.then(
      (ready) => {
        try {
          emit(ready, turn);
        } catch {
          // Never let telemetry break the turn.
        }
      },
      () => {
        // A failed load must not disable tracing for the rest of the process.
        if (loading === pending) {
          loading = null;
          client = null;
        }
      },
    );
  } catch {
    // Never let telemetry break the turn.
  }
}
