/**
 * Local regression tests for @deepseek-ai/dsh-llm-failover.
 *
 * Runs without the DeepSeek Harness: the plugin is loaded from ../lib/index.js
 * with its only runtime import ("@deepseek-ai/schemastery", which lives inside
 * the harness bundle) swapped for a stub, and every harness service it touches
 * is supplied by a small in-process double.
 *
 *   node test/smoke.test.mjs
 *
 * Exit code 0 = all checks passed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginSource = fs.readFileSync(path.join(here, "..", "lib", "index.js"), "utf8");

const stamp = Date.now();
// The plugin reads its version from the manifest beside it, so the sandbox has
// to look like a real install: <work>/lib/index.mjs + <work>/package.json.
const workDir = path.join(os.tmpdir(), "dsh-llm-failover-under-test-" + stamp);
const libDir = path.join(workDir, "lib");
fs.mkdirSync(libDir, { recursive: true });
fs.copyFileSync(path.join(here, "..", "package.json"), path.join(workDir, "package.json"));
const stubPath = path.join(workDir, "schemastery-stub.mjs");
fs.writeFileSync(stubPath, [
  "// Stub for @deepseek-ai/schemastery (loader schema is deliberately permissive).",
  "const z = function () {};",
  "z.object = function () { return { __schema: 'object' }; };",
  "z.string = z.number = z.boolean = z.array = z.union = z.any = z.object;",
  "export default z;",
  ""
].join("\n"));

const patchedSource = pluginSource.replace(
  /from "@deepseek-ai\/schemastery"/,
  "from " + JSON.stringify(pathToFileURL(stubPath).href)
);
if (patchedSource === pluginSource) {
  console.error("Could not stub @deepseek-ai/schemastery — did the import shape change?");
  process.exit(2);
}

const pluginPath = path.join(libDir, "index.mjs");
fs.writeFileSync(pluginPath, patchedSource);
const plugin = await import(pathToFileURL(pluginPath).href);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log("  PASS  " + name);
  } else {
    fail += 1;
    console.log("  FAIL  " + name + (extra ? "   -> " + extra : ""));
  }
}

function makeCtx() {
  const listeners = new Map();
  const logs = [];
  return {
    listeners,
    logs,
    ctx: {
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
        return () => {};
      },
      effect() {
        return () => {};
      },
      logger: {
        info: (m) => logs.push("I " + m),
        warn: (m) => logs.push("W " + m),
        error: (m) => logs.push("E " + m)
      }
    }
  };
}

const POOL = [
  { provider: "deepseek-official", model: "deepseek-flash" },
  { provider: "bailian", model: "qwen3.8-flash" },
  { provider: "ark-plan", model: "glm-5.3-flash" },
  { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" }
];

// --- activation reports the pool honestly
{
  const { ctx, logs } = makeCtx();
  plugin.apply(ctx, { enabled: true, maxConsecutiveFailures: 3, models: POOL });
  const active = logs.find((l) => l.indexOf("active (") >= 0);
  console.log("  [activation] " + active);
  check("activation log reports entries and distinct providers",
    !!active && active.indexOf("4 pool entry/entries covering 4 provider(s)") >= 0);
  const manifestVersion = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version;
  check("activation log names the deployed version",
    !!active && active.indexOf("(v" + manifestVersion + ";") >= 0, active);
  check("no inert-entry warning for a clean pool",
    !logs.some((l) => l.indexOf("repeat a provider") >= 0));
}

// --- duplicate-provider entries are called out as inert
{
  const { ctx, logs } = makeCtx();
  plugin.apply(ctx, { enabled: true, models: [{ provider: "agnes", model: "a" }, { provider: "agnes", model: "b" }] });
  const warning = logs.find((l) => l.indexOf("repeat a provider") >= 0);
  console.log("  [duplicates] " + warning);
  check("duplicate-provider entries are flagged inert", !!warning && warning.indexOf("inert") >= 0);
}

// --- cooldown cannot be cancelled by a route we rewrote ourselves,
//     while a genuine success from an untouched provider still recovers it
{
  const { ctx, listeners, logs } = makeCtx();
  let clock = 1000000;
  plugin.apply(
    ctx,
    { enabled: true, maxConsecutiveFailures: 3, cooldownSeconds: 60, models: POOL },
    { now: () => clock, sleep: async () => {} }
  );

  const onRequestError = listeners.get("agent/request-error")[0];
  const onRequest = listeners.get("agent/request")[0];
  const onSessionEvent = listeners.get("session/event")[0];
  const assistantFrom = (provider) =>
    onSessionEvent(null, { type: "assistant/message", data: { message: { source: { provider } } } });

  const arkFailure = { agent: { id: "a1" }, turn: 1, provider: "ark-plan", failure: { code: "RATE_LIMIT", message: "429 quota exceeded" } };
  for (let i = 0; i < 3; i++) await onRequestError(arkFailure, async () => undefined);
  check("provider enters cooldown after the failure threshold",
    logs.some((l) => l.indexOf('provider "ark-plan" parked for 60s after 3 consecutive') >= 0));

  const rebuilt = await onRequest({}, async () => ({ provider: "ark-plan", model: "ark-code-latest", reasoningEffort: "high" }));
  check("unhealthy route is rewritten to the next healthy target",
    !!rebuilt && rebuilt.provider === "deepseek-official", JSON.stringify(rebuilt));
  check("stale per-model reasoningEffort is dropped",
    !!rebuilt && rebuilt.reasoningEffort === undefined);

  assistantFrom("ark-plan");
  console.log("  [cooldown-guard] " + logs.find((l) => l.indexOf("ignoring a success") >= 0));
  check("ambiguous success during cooldown is refused",
    logs.some((l) => l.indexOf("ignoring a success attributed to") >= 0));
  check("cooldown survives the ambiguous success",
    !logs.some((l) => l.indexOf('provider "ark-plan" recovered') >= 0));

  const bailianFailure = { agent: { id: "a2" }, turn: 1, provider: "bailian", failure: { code: "SERVER", message: "503" } };
  for (let i = 0; i < 3; i++) await onRequestError(bailianFailure, async () => undefined);
  check("second provider enters cooldown", logs.some((l) => l.indexOf('provider "bailian" parked for 60s') >= 0));
  assistantFrom("bailian");
  check("providers never rerouted away from still recover on proven output",
    logs.some((l) => l.indexOf('provider "bailian" recovered') >= 0));

  clock += 61 * 1000;
  const afterCooldown = await onRequest({}, async () => ({ provider: "ark-plan", model: "ark-code-latest" }));
  check("route is served natively again once the cooldown elapses",
    !!afterCooldown && afterCooldown.provider === "ark-plan", JSON.stringify(afterCooldown));
}

// --- configuration sanitising degrades instead of throwing
{
  const { ctx, logs } = makeCtx();
  plugin.apply(ctx, {
    enabled: true,
    cooldownSeconds: -5,
    maxConsecutiveFailures: 0,
    unknownSetting: 1,
    models: [{ provider: "x", model: "y" }, { provider: 5 }, "junk"]
  });
  check("non-positive cooldown is rejected", logs.some((l) => l.indexOf("cooldownSeconds") >= 0));
  check("non-positive integer is rejected", logs.some((l) => l.indexOf("maxConsecutiveFailures") >= 0));
  check("unknown key is reported", logs.some((l) => l.indexOf("unknownSetting") >= 0));
  check("malformed pool entries are dropped", logs.some((l) => l.indexOf("malformed models") >= 0));
}

// --- containment: a broken payload must degrade to pass-through, never throw
{
  const { ctx, listeners } = makeCtx();
  plugin.apply(ctx, { enabled: true, models: POOL });
  const onRequestError = listeners.get("agent/request-error")[0];
  let threw = false;
  let downstreamCalled = false;
  try {
    await onRequestError(null, async () => {
      downstreamCalled = true;
      return { kind: "retry" };
    });
  } catch (error) {
    threw = true;
  }
  check("null payload degrades to pass-through", !threw && downstreamCalled);

  const second = makeCtx();
  const result = plugin.apply(second.ctx, { enabled: true, models: POOL });
  check("activation returns without throwing", true);
  check("all four harness hooks are registered",
    second.listeners.has("agent/request-error") &&
    second.listeners.has("agent/request") &&
    second.listeners.has("session/event") &&
    second.listeners.has("agent/status"));
  check("dispose handle is returned", typeof result === "function" || result === undefined);
}

// --- credential scrubbing
{
  const { ctx, listeners, logs } = makeCtx();
  plugin.apply(ctx, { enabled: true, models: POOL });
  const onRequestError = listeners.get("agent/request-error")[0];
  const sentinel = "sk-SENTINEL-DO-NOT-LEAK";
  await onRequestError({
    agent: { id: "scrub" },
    turn: 1,
    provider: "ark-plan",
    failure: { code: "RATE_LIMIT", message: "429 from https://gw.example/v1?api_key=" + sentinel + " x-api-key: " + sentinel + " Authorization: Bearer " + sentinel }
  }, async () => undefined);
  const joined = logs.join("\n");
  check("query-parameter credential is masked", joined.indexOf("api_key=" + sentinel) < 0);
  check("header-shaped credential is masked", joined.indexOf("x-api-key: " + sentinel) < 0);
  check("bearer token is masked", joined.indexOf("Bearer " + sentinel) < 0);
}

// --- resolveResetPlan: what counts as a wall (deterministic-until-reset)
{
  const nowMs = 1_700_000_000_000;
  const wallByCode = plugin.resolveResetPlan({ code: "QUOTA", message: "no credits" }, nowMs);
  check("QUOTA is a wall with no published reset",
    wallByCode.wall === true && wallByCode.parkMs === undefined && wallByCode.source === "quota-code");

  const wallByRetryAfter = plugin.resolveResetPlan({ code: "RATE_LIMIT", message: "429", providerRetryAfterMs: 3 * 3600 * 1000 }, nowMs);
  check("a published long retry-after is a wall parked for exactly that",
    wallByRetryAfter.wall === true && wallByRetryAfter.parkMs === 3 * 3600 * 1000);

  const blip = plugin.resolveResetPlan({ code: "RATE_LIMIT", message: "429 slow down", providerRetryAfterMs: 1500 }, nowMs);
  check("a 1.5s retry-after stays a blip", blip.wall === false && blip.parkMs === 1500);

  const ambiguous = plugin.resolveResetPlan({ code: "RATE_LIMIT", message: "quota exceeded" }, nowMs);
  check("ambiguous 'quota exceeded' alone is not a wall (could be a per-minute meter)", ambiguous.wall === false);

  const named = plugin.resolveResetPlan({ code: "RATE_LIMIT", message: "insufficient credits on this account" }, nowMs);
  check("account-level wording is a wall even without a reset", named.wall === true && named.source === "message-marker");

  const stamped = plugin.resolveResetPlan(
    { code: "RATE_LIMIT", message: "usage limit for your plan has been reached; resets at 2026-09-25T03:38:40Z" },
    Date.parse("2026-09-25T00:38:40Z")
  );
  check("a named window with a reset stamp parks until the stamp",
    stamped.wall === true && stamped.parkMs === 3 * 3600 * 1000 && stamped.source === "reset-stamp");

  const prose = plugin.resolveResetPlan({ code: "RATE_LIMIT", message: "server busy, retry again in 2 hours" }, nowMs);
  check("prose retry-after is parsed", prose.wall === true && prose.parkMs === 2 * 3600 * 1000);

  const absurd = plugin.resolveResetPlan({ code: "RATE_LIMIT", message: "429", providerRetryAfterMs: 400 * 24 * 3600 * 1000 }, nowMs);
  check("an absurd far-future reset is not believed", absurd.wall === false && absurd.parkMs === undefined);
}

// --- a wall switches on the FIRST failure and parks for hours, then probes
{
  const { ctx, listeners, logs } = makeCtx();
  let clock = 2000000;
  plugin.apply(ctx, { enabled: true, maxConsecutiveFailures: 3, models: POOL }, { now: () => clock, sleep: async () => {} });
  const onRequestError = listeners.get("agent/request-error")[0];
  const onRequest = listeners.get("agent/request")[0];

  const first = await onRequestError({
    agent: { id: "w1" }, turn: 1, provider: "commandcode",
    failure: { code: "QUOTA", message: "usage limit for your plan has been reached" }
  }, async () => undefined);
  check("a quota wall switches on the FIRST failure (no threshold to earn)", first?.kind === "retry");
  check("the wall park is hours, not the 60s blip cooldown",
    logs.some((l) => l.indexOf('provider "commandcode" parked for 4h (quota-code)') >= 0));

  clock += 4 * 3600 * 1000 - 1000;
  const stillParked = await onRequest({}, async () => ({ provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" }));
  check("the wall park still holds an hour before its end",
    !!stillParked && stillParked.provider === "deepseek-official", JSON.stringify(stillParked));

  clock += 2000;
  const probing = await onRequest({}, async () => ({ provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" }));
  check("after the wall park the provider gets its probe", !!probing && probing.provider === "commandcode");
  check("the probe admission is logged",
    logs.some((l) => l.indexOf('provider "commandcode" cooldown elapsed; admitting it back as a probe') >= 0));
}

// --- a published reset shorter than a minute is a blip, not a wall
{
  const { ctx, listeners, logs } = makeCtx();
  plugin.apply(ctx, { enabled: true, maxConsecutiveFailures: 3, models: POOL }, { now: () => 3000000, sleep: async () => {} });
  const onRequestError = listeners.get("agent/request-error")[0];
  const result = await onRequestError({
    agent: { id: "b1" }, turn: 1, provider: "ark-plan",
    failure: { code: "RATE_LIMIT", message: "slow down", providerRetryAfterMs: 2000 }
  }, async () => undefined);
  check("a 2s published reset does not skip the threshold", result?.kind === "retry" && !logs.some((l) => l.indexOf('provider "ark-plan" parked') >= 0));
}

// --- half-open: the probe decides, and a failed probe re-parks immediately
{
  const { ctx, listeners, logs } = makeCtx();
  let clock = 5000000;
  plugin.apply(ctx, { enabled: true, maxConsecutiveFailures: 3, cooldownSeconds: 60, models: POOL },
    { now: () => clock, sleep: async () => {} });
  const onRequestError = listeners.get("agent/request-error")[0];
  const onRequest = listeners.get("agent/request")[0];
  const onSessionEvent = listeners.get("session/event")[0];
  const fail = () => ({ agent: { id: "h1" }, turn: 1, provider: "bailian", failure: { code: "SERVER", message: "503" } });
  const bailianRoute = async () => ({ provider: "bailian", model: "qwen3.8-flash" });

  for (let i = 0; i < 3; i++) await onRequestError(fail(), async () => undefined);
  check("threshold park is the blip cooldown", logs.some((l) => l.indexOf('provider "bailian" parked for 60s after 3 consecutive') >= 0));

  clock += 61 * 1000;
  const probe = await onRequest({}, bailianRoute);
  check("the half-open provider is admitted for its probe", !!probe && probe.provider === "bailian");

  const probeFailed = await onRequestError(fail(), async () => undefined);
  check("a failed probe re-parks immediately (no threshold to re-earn)", probeFailed?.kind === "retry");
  check("the re-park escalates the cooldown (60s -> 2m)",
    logs.some((l) => l.indexOf('provider "bailian" parked for 2m after a failed probe') >= 0));

  clock += 121 * 1000;
  const probe2 = await onRequest({}, bailianRoute);
  check("the second probe is admitted after the escalated cooldown", !!probe2 && probe2.provider === "bailian");
  onSessionEvent(null, { type: "assistant/message", data: { message: { source: { provider: "bailian" } } } });
  check("a proven outcome clears the ledger and the penalty",
    logs.some((l) => l.indexOf('provider "bailian" probe succeeded after 2 park(s)') >= 0));

  clock += 61 * 1000;
  const clean = await onRequest({}, bailianRoute);
  check("no residual parking after the penalty was cleared", !!clean && clean.provider === "bailian");
}

// --- terminal path names the earliest recovery and dumps every state
{
  const { ctx, listeners, logs } = makeCtx();
  plugin.apply(ctx, { enabled: true, maxConsecutiveFailures: 3, models: POOL }, { now: () => 7000000, sleep: async () => {} });
  const onRequestError = listeners.get("agent/request-error")[0];
  for (const provider of ["deepseek-official", "bailian", "ark-plan", "commandcode"]) {
    const decision = await onRequestError({
      agent: { id: "t1" }, turn: 1, provider,
      failure: { code: "QUOTA", message: "insufficient credits" }
    }, async () => undefined);
    if (provider === "commandcode") check("with no target left the listener stands down", decision === undefined);
  }
  check("terminal log names the earliest recovery", logs.some((l) => l.indexOf("Earliest recovery:") >= 0));
  check("terminal log dumps every provider's state",
    logs.some((l) => l.indexOf("provider states:") >= 0 && l.indexOf("parked(") >= 0));
}

// --- a copy without its manifest still activates: the version degrades, nothing throws
{
  const bareLib = path.join(workDir, "bare", "lib");
  fs.mkdirSync(bareLib, { recursive: true });
  const barePath = path.join(bareLib, "index.mjs");
  fs.writeFileSync(barePath, patchedSource);
  const bare = await import(pathToFileURL(barePath).href);
  const { ctx: bareCtx, logs: bareLogs } = makeCtx();
  let threw = false;
  try {
    bare.apply(bareCtx, { enabled: true, models: POOL });
  } catch {
    threw = true;
  }
  const bareLine = bareLogs.find((l) => l.indexOf("active (") >= 0);
  check("a copy without its manifest still activates", !threw && !!bareLine);
  check("and says the version is unknown rather than lying", !!bareLine && bareLine.indexOf("(vunknown;") >= 0, bareLine);
}

console.log("");
console.log("RESULT: " + pass + " passed, " + fail + " failed");
try {
  fs.rmSync(workDir, { recursive: true, force: true });
} catch {}
process.exit(fail === 0 ? 0 : 1);
