import { readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, basename } from "node:path";
import type { LogLevel } from "../types.js";

// ---------------------------------------------------------------------------
// Mule runtime log adapter — CLIENT-AGNOSTIC.
//
// Every MuleSoft customer's runtime emits the same log layout regardless of how
// they name their apps, flows or queues:
//
//   LEVEL  yyyy-MM-dd HH:mm:ss,SSS [thread] [processor: <flow>/...; event: <corrId>] <logger>: <message>
//   ...optional multi-line error block...
//     Error type            : SAP:CONNECTIVITY
//     FlowStack             : at someFlow(someFlow/processors/6 @ app-1.0.0-...:file.xml:47 (BAPI_X))
//
// We parse that universal shape — no naming convention is assumed. App identity
// comes from the log *filename*, not from any prefix. This is what lets the same
// server work for any customer's estate by just pointing it at a logs directory.
// ---------------------------------------------------------------------------

const LEVELS = new Set(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]);

export interface MuleRecord {
  app: string;
  level: LogLevel;
  ts: string; // ISO-ish, local time as logged
  epochMs: number;
  thread: string;
  flow?: string;
  processor?: string;
  correlationId?: string;
  logger?: string;
  message: string;
  errorType?: string;
  /** First meaningful FlowStack frame, e.g. "someFlow(... (BAPI_ACC_DOCUMENT_POST))". */
  flowStackHead?: string;
  /** The failing component doc:name, parsed from the FlowStack frame if present. */
  failingComponent?: string;
  /** The "Element : ..." line of an error block (failing element + file:line). */
  element?: string;
}

const RECORD_START = /^(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),(\d{3})\b/;

// LEVEL  ts [thread] [processor: P; event: E] logger: message
const HEADER =
  /^(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\s+\[(.*?)\]\s+(?:\[processor:\s*([^;\]]*);\s*event:\s*([^\]]*)\]\s+)?(?:([\w.$]+):\s?)?([\s\S]*)$/;

const ERROR_TYPE = /Error type\s*:\s*([A-Z0-9_][A-Z0-9_:.\-]*)/;
const FLOWSTACK = /FlowStack\s*:\s*(at\s+[^\n]+)/;
const FLOWSTACK_COMPONENT = /\(([^()]*)\)\s*$/m;
const ERR_MESSAGE = /^Message\s*:\s*(.+)$/m;
const ERR_ELEMENT = /^Element\s*:\s*(.+)$/m;

function toEpoch(date: string, millis: string): number {
  // "2026-05-18 18:37:19" + ",028" → local time epoch.
  const iso = date.replace(" ", "T") + "." + millis;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function appIdFromFilename(file: string): string {
  let name = basename(file);
  name = name.replace(/\.gz$/i, "").replace(/\.log$/i, "");
  // strip rotation suffixes: ".2026-03-05" date stamps and "-1"/"-2" indices
  name = name.replace(/\.\d{4}-\d{2}-\d{2}$/, "");
  name = name.replace(/[._-]\d{1,3}$/, "");
  return name || "unknown-app";
}

/** Files that are runtime/infra noise rather than a deployable app log. */
function isSkippable(file: string): boolean {
  const b = basename(file);
  if (b.includes("${")) return true; // unresolved log4j pattern, e.g. ${sys:domain}.log
  if (/^mule[-_]ee/i.test(b)) return true; // runtime aggregate log
  if (/^wrapper/i.test(b)) return true;
  return false;
}

function readMaybeGzip(path: string): string {
  const buf = readFileSync(path);
  if (path.endsWith(".gz")) return gunzipSync(buf).toString("utf8");
  return buf.toString("utf8");
}

function parseRecordBlock(app: string, lines: string[]): MuleRecord | null {
  const head = lines[0];
  const m = HEADER.exec(head);
  if (!m) return null;
  const [, level, ts, thread, processor, correlationId, logger, firstMsg] = m;
  const body = lines.join("\n");

  const errorTypeMatch = ERROR_TYPE.exec(body);
  const flowStackMatch = FLOWSTACK.exec(body);
  const flowStackHead = flowStackMatch?.[1]?.trim();

  // Flow name: prefer the processor path's leading segment, else the FlowStack frame.
  let flow: string | undefined;
  if (processor && processor.trim()) flow = processor.trim().split("/")[0];
  else if (flowStackHead) {
    const fm = /at\s+([^(]+)\(/.exec(flowStackHead);
    if (fm) flow = fm[1].trim();
  }

  let failingComponent: string | undefined;
  if (flowStackHead) {
    const cm = FLOWSTACK_COMPONENT.exec(flowStackHead);
    if (cm) failingComponent = cm[1].trim();
  }

  const errMessage = ERR_MESSAGE.exec(body)?.[1]?.trim();
  const element = ERR_ELEMENT.exec(body)?.[1]?.trim();

  // The logger line is often empty for error records (the detail is in the
  // block). Fall back to the block's "Message :" / errorType so every record
  // carries something useful.
  const headerMsg = (firstMsg ?? "").split("\n")[0].trim();
  let message = headerMsg;
  if (!message && errMessage && errMessage.toLowerCase() !== "null") message = errMessage;
  if (!message && errorTypeMatch) message = errorTypeMatch[1];

  const [date, time] = ts.split(" ");
  return {
    app,
    level: (LEVELS.has(level) ? level : "INFO") as LogLevel,
    ts: `${date}T${time.replace(",", ".")}`,
    epochMs: toEpoch(`${date} ${time.split(",")[0]}`, time.split(",")[1] ?? "000"),
    thread: thread ?? "",
    flow,
    processor: processor?.trim() || undefined,
    correlationId: correlationId?.trim() || undefined,
    logger,
    message,
    errorType: errorTypeMatch?.[1],
    flowStackHead,
    failingComponent,
    element,
  };
}

/**
 * Parse raw Mule log text (a whole file, or a concatenation of CloudHub 2.0 log
 * entries) into records. Splits on each new log record (LEVEL + date) so the
 * multi-line error block stays attached to its header line.
 */
export function parseLogText(app: string, text: string): MuleRecord[] {
  const out: MuleRecord[] = [];
  let block: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (RECORD_START.test(line)) {
      if (block.length) {
        const rec = parseRecordBlock(app, block);
        if (rec) out.push(rec);
      }
      block = [line];
    } else if (block.length) {
      block.push(line);
    }
  }
  if (block.length) {
    const rec = parseRecordBlock(app, block);
    if (rec) out.push(rec);
  }
  return out;
}

export function parseLogFile(path: string): MuleRecord[] {
  return parseLogText(appIdFromFilename(path), readMaybeGzip(path));
}

function collectLogFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // Skip obvious build/IDE noise to stay fast and relevant.
      if (/^(target|node_modules|\.metadata|\.git|debug)$/i.test(entry)) continue;
      collectLogFiles(full, acc);
    } else if (/\.log(\.gz)?$/i.test(entry) && !isSkippable(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

export interface MuleLogIndex {
  dir: string;
  apps: string[];
  records: MuleRecord[];
  /** Latest log timestamp seen — the dataset's "now" for relative windows. */
  asOfEpochMs: number;
  fileCount: number;
}

export function loadLogDir(dir: string, maxRecordsPerFile = 50_000): MuleLogIndex {
  const files = collectLogFiles(dir);
  const records: MuleRecord[] = [];
  for (const f of files) {
    try {
      const recs = parseLogFile(f);
      records.push(...recs.slice(-maxRecordsPerFile));
    } catch {
      // ignore unreadable files
    }
  }
  records.sort((a, b) => a.epochMs - b.epochMs);
  const apps = [...new Set(records.map((r) => r.app))].sort();
  const asOfEpochMs = records.reduce((mx, r) => Math.max(mx, r.epochMs), 0);
  return { dir, apps, records, asOfEpochMs, fileCount: files.length };
}
