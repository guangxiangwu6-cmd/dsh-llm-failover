// qa-s0-session-compat.mjs - QA t4/S0 decisive experiment:
// Load crafted session logs through the REAL persistence stack from the smoke
// rehearsal tree (@deepseek-ai/dsh-session-persistence + -jsonl), observing
// whether an 'llm/failover' event makes a persisted log unopenable.
import { zstdCompressSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const SMOKEMODS = "file:///D:/DSH-dev/smoke/node_modules/";
const { SessionFormatUnsupportedError } = await import(SMOKEMODS + "@deepseek-ai/dsh-session-persistence/lib/index.js");
const { JsonlSessionPersistence } = await import(SMOKEMODS + "@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js");

const ROOT = "D:/DSH-dev/smoke/qa-s0/sessions";
const SLUG = "--C-Users-35100-OneDrive-~684C~9762-~684C~9762~6587~4EF6--"; // copied verbatim from real smoke home layout
const CWD = "C:\\Users\\35100\\OneDrive\\桌面\\桌面文件"; // matches the real smoke-home cwd encoding

function makeBackend() {
  const logger = { info() {}, warn() {}, error() {} };
  const ctx = {
    logger,
    reflect: { provide() {} }, // minimal cordis Service registration seam
    sessions: {
      list: () => [],
      get: () => undefined,
      // Minimal materializer: the format gate (assertEventsSupported) already ran before this is reached.
      prepare: (id, opts) => ({ header: opts.meta, events: [...opts.seed] })
    },
    effect() { return () => {}; },
    on() { return () => {}; }
  };
  fs.mkdirSync(ROOT, { recursive: true });
  return new JsonlSessionPersistence(ctx, { root: ROOT });
}

function writeLog(id, extraEvents) {
  // Production framing (per reader contract): first zstd frame = exactly the header line;
  // each subsequent record gets its own zstd frame.
  const header = { type: "session", version: 0, id, createdAt: Date.now(), cwd: CWD, delegationDepth: 0 };
  const lines = [JSON.stringify(header), ...extraEvents.map((e) => JSON.stringify(e))];
  const frames = lines.map((l) => zstdCompressSync(Buffer.from(l + "\n", "utf8")));
  const dir = path.join(ROOT, SLUG, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session.jsonl.zstd"), Buffer.concat(frames));
}

function ev(type, seq, extra = {}) {
  return { type, seq, time: Date.now(), data: { probe: true }, sourceEventSeqs: [], ...extra };
}

async function tryLoad(backend, label, fn) {
  try {
    await fn();
    console.log("RESULT " + label + ": LOADED OK (no refusal)");
    return "ok";
  } catch (error) {
    if (error instanceof SessionFormatUnsupportedError || error.name === "SessionFormatUnsupportedError") {
      console.log("RESULT " + label + ": REFUSED -> " + error.name);
      console.log("  message: " + error.message.slice(0, 300));
      return "refused";
    }
    console.log("RESULT " + label + ": OTHER ERROR -> " + error.name + ": " + String(error.message).slice(0, 200));
    return "other";
  }
}

console.log("=== S0 experiment: real load paths over crafted logs ===");
writeLog("session-qa-s0-control", []);
writeLog("session-qa-s0-retry-known", [ev("llm/retry", 0)]);
writeLog("session-qa-s0-failover-unknown", [ev("llm/failover", 0)]);
writeLog("session-qa-s0-failover-ignorable", [ev("llm/failover", 0, { ignorable: true })]);

for (const [label, id] of [
  ["prepare(control clean log)", "session-qa-s0-control"],
  ["prepare(llm/retry known type)", "session-qa-s0-retry-known"],
  ["prepare(llm/failover UNKNOWN)", "session-qa-s0-failover-unknown"],
  ["readFrom(llm/failover UNKNOWN, suffix path)", "session-qa-s0-failover-unknown"],
  ["prepare(llm/failover + ignorable:true)", "session-qa-s0-failover-ignorable"]
]) {
  const backend = makeBackend();
  const fn = label.startsWith("readFrom")
    ? () => backend.readFrom(id, 0)
    : () => backend.prepare(id);
  await tryLoad(backend, label, fn);
}
