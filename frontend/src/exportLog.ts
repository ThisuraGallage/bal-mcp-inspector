import packageJson from "../package.json";
import type { InspectorEvent } from "./types";
import { buildExchanges, decodedToken, durationMs, formParams, headerValue, HttpExchange, targetLabel } from "./requests";

// Facts about the connection that a reader of an exported log needs to match it to a test run.
export interface ExportContext {
  connectionId: string;
  fields: [string, string][];
}

const TOOL_NAME = "WSO2 MCP Playground";

const CAVEATS = [
  "Headers and bodies are as the Ballerina MCP client's observer reported them, not a wire capture.",
  "Credentials (authorization headers, cookies, client secrets and assertions, codes, tokens, PKCE verifiers) are replaced by [REDACTED].",
  "Header order and casing may differ from the wire, and headers added by the HTTP transport (Host, Content-Length) are not shown.",
  "JSON responses are re-serialized by the client; SSE responses show only the data field of each event.",
  "Token requests are shown form-encoded, and token responses with their token values as [REDACTED].",
  "An issued ID-JAG is also shown decoded (header and payload, signature removed) in comments added by the playground, outside the recorded traffic.",
];

// Sequence numbers are gapless per connection, so a gap means events were cleared here or dropped by the backend.
export function sequenceGaps(events: InspectorEvent[]): string[] {
  const missing = (from: number, to: number) => from === to ? `event #${from} is missing` : `events #${from}-#${to} are missing`;
  const gaps: string[] = [];
  let previous = 0;
  for (const event of events) {
    if (event.sequence > previous + 1) gaps.push(missing(previous + 1, event.sequence - 1));
    previous = event.sequence;
  }
  return gaps;
}

function contextFields(events: InspectorEvent[], context: ExportContext): [string, string][] {
  const first = events[0];
  const last = events[events.length - 1];
  return [
    ["Exported", new Date().toISOString()],
    ["Tool", `${TOOL_NAME} ${packageJson.version} (${window.location.origin})`],
    ...context.fields,
    ["Events", first ? `${events.length} (#${first.sequence}-#${last.sequence}, ${first.timestamp} to ${last.timestamp})` : "0"],
  ];
}

function headerFields(events: InspectorEvent[], context: ExportContext): [string, string][] {
  return [...contextFields(events, context), ...sequenceGaps(events).map((gap): [string, string] => ["Gap", gap])];
}

function headerLines(event: InspectorEvent): string[] {
  return Object.entries(event.eventHeaders ?? {}).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`));
}

function isEventStream(exchange: HttpExchange) {
  return (headerValue(exchange.response, "content-type") ?? "").includes("text/event-stream");
}

function responseBodyText(exchange: HttpExchange) {
  if (isEventStream(exchange)) {
    return exchange.bodies.map((event) => `data: ${event.eventBody ?? ""}\n`).join("\n");
  }
  return exchange.bodies.map((event) => event.eventBody ?? "").join("\n");
}

// Form bodies are rebuilt from the recorded parameters, leaving redaction markers readable.
function requestBodyText(event: InspectorEvent) {
  const params = formParams(event);
  return params ? new URLSearchParams(params).toString().replaceAll("%5BREDACTED%5D", "[REDACTED]") : event.eventBody;
}

function withBody(lines: string[], body: string | undefined) {
  return body ? [...lines, "", body.replace(/\n+$/, "")] : lines;
}

// Tokens the playground decoded, as comment lines kept apart from the recorded request and response.
function decodedTokenLines(exchange: HttpExchange): string[] {
  return exchange.decoded.flatMap((event) => {
    const decoded = decodedToken(event);
    if (!decoded) return [`# ${event.eventMessage ?? "The token could not be decoded."}`];
    return [
      `# ${decoded.token} in access_token (added by the playground: signature removed, header and payload decoded)`,
      `# header:  ${JSON.stringify(decoded.header)}`,
      `# payload: ${JSON.stringify(decoded.payload)}`,
    ];
  });
}

function exchangeLines(exchange: HttpExchange): string[] {
  const { request, response } = exchange;
  const target = targetLabel(request.eventTarget);
  const lines = [`>>> #${request.sequence}  ${request.timestamp}  to ${target}`];
  if (request.eventMessage) lines.push(`# ${request.eventMessage}`);
  lines.push(...withBody([`${request.httpMethod ?? "HTTP"} ${request.eventUrl ?? ""}`, ...headerLines(request)], requestBodyText(request)));
  lines.push("");

  if (response) {
    const duration = durationMs(exchange);
    lines.push(`<<< #${response.sequence}  ${response.timestamp}  from ${target}${duration === undefined ? "" : `  ${duration} ms`}`);
    if (response.eventMessage) lines.push(`# ${response.eventMessage}`);
    for (const note of exchange.notes) lines.push(`# ${note.eventType}: ${note.eventMessage ?? ""}`);
    const statusLine = `HTTP ${response.statusCode ?? ""}`.trim();
    lines.push(...withBody([statusLine, ...headerLines(response)], responseBodyText(exchange)));
    const decoded = decodedTokenLines(exchange);
    if (decoded.length > 0) lines.push("", ...decoded);
  } else {
    lines.push("<<< (no response)");
  }
  for (const error of exchange.errors) lines.push(`# ${error.eventType}: ${error.eventMessage ?? ""}`);
  return lines;
}

// One exchange as HTTP-style text, for the Raw view and copying.
export function exchangeTranscript(exchange: HttpExchange) {
  return exchangeLines(exchange).join("\n");
}

function absorbedSequences(exchanges: HttpExchange[]) {
  const sequences = new Set<number>();
  for (const exchange of exchanges) {
    for (const event of [exchange.request, exchange.response, ...exchange.bodies, ...exchange.errors, ...exchange.notes,
      ...exchange.decoded]) {
      if (event) sequences.add(event.sequence);
    }
  }
  return sequences;
}

// The whole session in event order: HTTP exchanges at the time they were sent, other client events as one-liners.
export function sessionTranscript(events: InspectorEvent[], context: ExportContext) {
  const exchanges = buildExchanges(events);
  const byRequest = new Map(exchanges.map((exchange) => [exchange.request.sequence, exchange]));
  const absorbed = absorbedSequences(exchanges);

  const header = [
    `# ${TOOL_NAME}: HTTP transcript`,
    ...headerFields(events, context).map(([label, value]) => `# ${label.padEnd(24)}${value}`),
    "#",
    ...CAVEATS.map((caveat) => `# ${caveat}`),
    "# >>> request sent, <<< response received, --- other client events. #n is the event sequence number.",
  ];

  const blocks: string[] = [];
  for (const event of events) {
    const exchange = byRequest.get(event.sequence);
    if (exchange) {
      blocks.push(exchangeTranscript(exchange));
    } else if (!absorbed.has(event.sequence)) {
      const detail = [event.httpMethod, event.eventUrl, event.statusCode, event.eventMessage, event.authorizationUrl]
        .filter((value) => value !== undefined && value !== null && value !== "").join("  ");
      blocks.push(`--- #${event.sequence}  ${event.timestamp}  ${event.eventType}${detail ? `  ${detail}` : ""}`);
    }
  }
  return `${header.join("\n")}\n\n${blocks.join("\n\n")}\n`;
}

function harHeaders(event: InspectorEvent | undefined) {
  return Object.entries(event?.eventHeaders ?? {}).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((item) => ({ name, value: item })));
}

function harQuery(url: string | undefined) {
  try {
    return [...new URL(url ?? "").searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

const HAR_PAGE_ID = "connection";

function harEntry(exchange: HttpExchange) {
  const { request, response } = exchange;
  const requestType = headerValue(request, "content-type") ?? "";
  const requestText = requestBodyText(request);
  const params = formParams(request);
  const responseType = headerValue(response, "content-type") ?? "";
  const responseText = responseBodyText(exchange);
  const time = durationMs(exchange) ?? 0;
  const comments = [
    request.eventMessage,
    response?.eventMessage,
    ...exchange.notes.map((note) => note.eventMessage),
    ...exchange.errors.map((error) => error.eventMessage),
    ...decodedTokenLines(exchange).map((line) => line.replace(/^# /, "")),
  ].filter(Boolean);
  return {
    pageref: HAR_PAGE_ID,
    startedDateTime: request.timestamp,
    time,
    request: {
      method: request.httpMethod ?? "GET",
      url: request.eventUrl ?? "",
      httpVersion: "unknown",
      cookies: [],
      headers: harHeaders(request),
      queryString: harQuery(request.eventUrl),
      ...(requestText ? {
        postData: {
          mimeType: requestType,
          text: requestText,
          ...(params ? { params: params.map(([name, value]) => ({ name, value })) } : {}),
        },
      } : {}),
      headersSize: -1,
      bodySize: requestText?.length ?? 0,
    },
    response: {
      status: response?.statusCode ?? 0,
      statusText: "",
      httpVersion: "unknown",
      cookies: [],
      headers: harHeaders(response),
      content: { size: responseText.length, mimeType: responseType, text: responseText },
      redirectURL: headerValue(response, "location") ?? "",
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
    ...(comments.length > 0 ? { comment: comments.join("\n") } : {}),
    // Custom fields keep what HAR has no place for: the observer's view of the exchange.
    _sequence: request.sequence,
    _target: request.eventTarget,
    _errors: exchange.errors.map((error) => ({ eventType: error.eventType, message: error.eventMessage })),
  };
}

export function harLog(events: InspectorEvent[], context: ExportContext) {
  const comment = [
    ...headerFields(events, context).map(([label, value]) => `${label}: ${value}`),
    ...CAVEATS,
  ].join("\n");
  const har = {
    log: {
      version: "1.2",
      creator: { name: TOOL_NAME, version: packageJson.version },
      comment,
      // Optional in HAR 1.2, but Firefox's importer fails without it. One page stands for the connection.
      pages: [{
        startedDateTime: events[0]?.timestamp ?? new Date().toISOString(),
        id: HAR_PAGE_ID,
        title: `MCP connection ${context.connectionId}`,
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      }],
      entries: buildExchanges(events).map(harEntry),
    },
  };
  return JSON.stringify(har, null, 2);
}

// Every observer event exactly as the backend streamed it, including those the other formats fold away.
export function eventJournal(events: InspectorEvent[], context: ExportContext) {
  return JSON.stringify({
    format: "bal-mcp-inspector.events/1",
    context: Object.fromEntries(contextFields(events, context)),
    gaps: sequenceGaps(events),
    notes: CAVEATS,
    events,
  }, null, 2);
}

export type ExportFormat = "transcript" | "har" | "events";

export const EXPORT_FORMATS: { format: ExportFormat; label: string; detail: string }[] = [
  { format: "transcript", label: "HTTP transcript", detail: ".txt, readable requests and responses" },
  { format: "har", label: "HAR", detail: ".har, opens in browser dev tools" },
  { format: "events", label: "Event journal", detail: ".json, every client event" },
];

export function downloadLog(format: ExportFormat, events: InspectorEvent[], context: ExportContext) {
  const [content, extension, type] = format === "transcript"
    ? [sessionTranscript(events, context), "txt", "text/plain"]
    : format === "har"
      ? [harLog(events, context), "har", "application/json"]
      : [eventJournal(events, context), "json", "application/json"];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  link.download = `mcp-inspector-${context.connectionId.slice(0, 8)}-${stamp}.${extension}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}
