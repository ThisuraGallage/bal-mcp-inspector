import type { InspectorEvent } from "./types";

export interface HttpExchange {
  id: number;
  request: InspectorEvent;
  response?: InspectorEvent;
  // Response content: raw bodies read outside the decoder and decoded JSON-RPC messages (one per SSE message).
  bodies: InspectorEvent[];
  errors: InspectorEvent[];
  notes: InspectorEvent[];
  // Tokens from this exchange's response that the playground decoded. Not part of the recorded traffic.
  decoded: InspectorEvent[];
}

export type StatusTone = "success" | "info" | "warning" | "danger" | "pending";

const ERROR_EVENTS = ["client.error", "tools.list_failed", "tools.call_failed"];

export const TOKEN_DECODED_EVENT = "playground.token_decoded";
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";

function issuesIdJag(exchange: HttpExchange) {
  return exchange.request.eventTarget === "identity_provider" && exchange.request.httpMethod === "POST" &&
    exchange.bodies.some((body) => asRecord(parseJson(body.eventBody))?.issued_token_type === ID_JAG_TOKEN_TYPE);
}

export interface DecodedToken {
  token: string;
  header: unknown;
  payload: unknown;
}

// The header and payload of a token the playground decoded, or undefined when it couldn't be decoded.
export function decodedToken(event: InspectorEvent): DecodedToken | undefined {
  const body = asRecord(parseJson(event.eventBody));
  return typeof body?.token === "string" && body.header !== undefined && body.payload !== undefined
    ? { token: body.token, header: body.header, payload: body.payload }
    : undefined;
}

function sameRoute(exchange: HttpExchange, event: InspectorEvent) {
  if (event.eventUrl && exchange.request.eventUrl !== event.eventUrl) return false;
  return !event.httpMethod || !exchange.request.httpMethod || event.httpMethod === exchange.request.httpMethod;
}

function findLast(exchanges: HttpExchange[], predicate: (exchange: HttpExchange) => boolean) {
  for (let index = exchanges.length - 1; index >= 0; index -= 1) {
    if (predicate(exchanges[index])) return exchanges[index];
  }
  return undefined;
}

// Pairs observer events into HTTP exchanges. Lifecycle events are dropped; they only end the current exchange.
export function buildExchanges(events: InspectorEvent[]): HttpExchange[] {
  const exchanges: HttpExchange[] = [];
  let current: HttpExchange | undefined;

  for (const event of events) {
    switch (event.eventType) {
      case "http.request":
        current = { id: event.sequence, request: event, bodies: [], errors: [], notes: [], decoded: [] };
        exchanges.push(current);
        break;
      case TOKEN_DECODED_EVENT: {
        // Recorded right after the token exchange that issued the ID-JAG. Unmatched, it stays a standalone event.
        const target = findLast(exchanges, (exchange) => exchange.decoded.length === 0 && issuesIdJag(exchange));
        target?.decoded.push(event);
        break;
      }
      case "http.response": {
        const target = findLast(exchanges, (exchange) => !exchange.response && sameRoute(exchange, event)) ??
          findLast(exchanges, (exchange) => !exchange.response);
        if (target) target.response = event;
        break;
      }
      case "http.body":
      case "mcp.message": {
        const target = findLast(exchanges, (exchange) => sameRoute(exchange, event));
        target?.bodies.push(event);
        break;
      }
      case "oauth.challenge":
        current?.notes.push(event);
        break;
      default:
        if (ERROR_EVENTS.includes(event.eventType)) {
          const target = event.eventUrl
            ? findLast(exchanges, (exchange) => sameRoute(exchange, event)) ?? current
            : current;
          target?.errors.push(event);
        } else if (event.eventType.startsWith("connection.")) {
          current = undefined;
        }
    }
  }
  return exchanges;
}

export function headerValue(event: InspectorEvent | undefined, name: string) {
  const entry = Object.entries(event?.eventHeaders ?? {})
    .find(([headerName]) => headerName.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(entry) ? entry.join(", ") : entry;
}

export function parseJson(text?: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// Parameters of a form-encoded request. The client's observer records token request parameters as a JSON
// object (with credentials redacted) rather than the encoded body, so both shapes are read.
export function formParams(event: InspectorEvent | undefined): [string, string][] | undefined {
  const body = event?.eventBody;
  if (!body || !(headerValue(event, "content-type") ?? "").includes("application/x-www-form-urlencoded")) return undefined;
  const parsed = asRecord(parseJson(body));
  if (parsed) return Object.entries(parsed).map(([name, value]) => [name, typeof value === "string" ? value : JSON.stringify(value)]);
  return [...new URLSearchParams(body).entries()];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export interface RequestName {
  // JSON-RPC method, or the URL path for plain HTTP requests.
  label: string;
  detail?: string;
  isRpc: boolean;
}

export function requestName(exchange: HttpExchange): RequestName {
  const body = parseJson(exchange.request.eventBody);
  const messages = Array.isArray(body) ? body.map(asRecord) : [asRecord(body)];
  const first = messages[0];
  const method = headerValue(exchange.request, "mcp-method") ??
    (typeof first?.method === "string" ? first.method : undefined);

  if (method) {
    const params = asRecord(first?.params);
    const detail = typeof params?.name === "string" ? params.name
      : typeof params?.uri === "string" ? params.uri : undefined;
    const extra = messages.length > 1 ? ` +${messages.length - 1}` : "";
    return { label: `${method}${extra}`, detail, isRpc: true };
  }

  try {
    const url = new URL(exchange.request.eventUrl ?? "");
    return { label: url.pathname || "/", isRpc: false };
  } catch {
    return { label: exchange.request.eventUrl ?? "request", isRpc: false };
  }
}

export function hostOf(value?: string) {
  if (!value) return "";
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

export function targetLabel(target: string) {
  const labels: Record<string, string> = {
    mcp_server: "MCP server",
    authorization_server: "Auth server",
    identity_provider: "Identity provider",
    protected_resource: "Resource",
    user_agent: "Browser",
    inspector: "Inspector",
  };
  return labels[target] ?? target.replaceAll("_", " ");
}

// Surfaces failures that a 2xx status hides: JSON-RPC errors and tool results flagged with isError.
export function responseProblem(exchange: HttpExchange): string | undefined {
  let problem: string | undefined;
  for (const event of exchange.bodies) {
    const value = parseJson(event.eventBody);
    for (const message of Array.isArray(value) ? value : [value]) {
      const record = asRecord(message);
      if (record?.error !== undefined) return "RPC error";
      if (asRecord(record?.result)?.isError === true) problem = "Tool error";
    }
  }
  if (!problem && exchange.errors.length > 0) problem = "Error";
  return problem;
}

export function exchangeStatus(exchange: HttpExchange): { label: string; tone: StatusTone } {
  const code = exchange.response?.statusCode;
  if (code === undefined) {
    return exchange.errors.length > 0 ? { label: "Failed", tone: "danger" } : { label: "Pending", tone: "pending" };
  }
  if (code >= 500) return { label: String(code), tone: "danger" };
  if (code === 401 || code === 403) return { label: String(code), tone: "warning" };
  if (code >= 400) return { label: String(code), tone: "danger" };
  if (code >= 300) return { label: String(code), tone: "info" };
  return { label: String(code), tone: exchange.errors.length > 0 ? "danger" : "success" };
}

export function lastEvent(exchange: HttpExchange) {
  return [exchange.request, exchange.response, ...exchange.bodies, ...exchange.errors]
    .filter((event): event is InspectorEvent => Boolean(event))
    .reduce((latest, event) => event.sequence > latest.sequence ? event : latest);
}

export function durationMs(exchange: HttpExchange) {
  if (!exchange.response) return undefined;
  const elapsed = new Date(lastEvent(exchange).timestamp).valueOf() - new Date(exchange.request.timestamp).valueOf();
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

export function formatDuration(elapsed?: number) {
  if (elapsed === undefined) return "";
  if (elapsed < 1000) return `${elapsed} ms`;
  return `${(elapsed / 1000).toFixed(elapsed < 10000 ? 2 : 1)} s`;
}

export function formatTime(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return timestamp;
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return `${time}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

export function exchangeMatches(exchange: HttpExchange, query: string) {
  if (!query) return true;
  const name = requestName(exchange);
  const haystack = [
    name.label,
    name.detail,
    exchange.request.httpMethod,
    exchange.request.eventUrl,
    exchange.response?.statusCode?.toString(),
    exchange.request.eventBody,
    ...exchange.bodies.map((event) => event.eventBody),
    ...exchange.errors.map((event) => event.eventMessage),
  ];
  return haystack.some((value) => value?.toLowerCase().includes(query));
}
