import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, resolveResetPlan } from "../lib/index.js";

/** No-op sleep keeps the self-fallback retry backoff instantaneous in tests. */
const NO_SLEEP = async () => {};

//#region mock harness
function makeCtx() {
    const listeners = new Map();
    const logs = [];
    const ctx = {
        logger: {
            info: (...a) => logs.push(["info", a.join(" ")]),
            warn: (...a) => logs.push(["warn", a.join(" ")]),
            error: (...a) => logs.push(["error", a.join(" ")])
        },
        on(name, cb, opts) {
            const list = listeners.get(name) ?? [];
            const entry = { cb };
            if (opts?.prepend) list.unshift(entry);
            else list.push(entry);
            listeners.set(name, list);
            return () => {
                const i = list.indexOf(entry);
                if (i >= 0) list.splice(i, 1);
                return true;
            };
        },
        effect(fn) { return fn; }
    };
    return { ctx, listeners, logs };
}

function makeAgent(id = "agent-1") {
    return {
        id,
        session: {
            appended: [],
            append(type, data) { this.appended.push({ type, data }); }
        }
    };
}

function errorPayload(agent, provider, code, message = "boom", turn = 7, step = 3) {
    return { agent, turn, step, provider, failure: { code, message }, retryPolicy: undefined, signal: undefined };
}

/** Invoke the plugin outermost agent/request-error listener over a configurable downstream stack. */
async function runError(listeners, payload, downstream = async () => undefined) {
    const entry = (listeners.get("agent/request-error") ?? [])[0];
    assert.ok(entry, "agent/request-error listener registered");
    return entry.cb(payload, downstream);
}

/** Invoke the plugin outermost agent/request listener over an inner resolution. */
async function runRequest(listeners, resolved, inner = async () => resolved) {
    const entry = (listeners.get("agent/request") ?? [])[0];
    assert.ok(entry, "agent/request listener registered");
    return entry.cb({ turn: 1, step: 0, signal: undefined }, inner);
}

function emitSessionEvent(listeners, event, session = {}) {
    for (const l of listeners.get("session/event") ?? []) l.cb(session, event);
}

function emitStatus(listeners, agent, status) {
    for (const l of listeners.get("agent/status") ?? []) l.cb({ agent, status });
}

/** Count host-log switch announcements; the only decision trail (no session events). */
function switchLogCount(logs) {
    return logs.filter(([, m]) => m.includes("temporarily switching to")).length;
}

/** Drive one provider through its full failure streak; returns the final decision. */
async function driveToSwitch(listeners, agent, provider, code = "RATE_LIMIT", threshold = 5) {
    let decision;
    for (let i = 1; i <= threshold; i++) decision = await runError(listeners, errorPayload(agent, provider, code));
    return decision;
}
//#endregion

test("Test 1: below-threshold failures delegate downstream and keep the same model", async () => {
    const { ctx, listeners } = makeCtx();
    let clock = 1000;
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const agent = makeAgent();
    let downstreamClaims = 0;
    const downstream = async () => { downstreamClaims += 1; return { kind: "retry" }; };
    for (let i = 1; i < 5; i++) {
        const decision = await runError(listeners, errorPayload(agent, "A", "RATE_LIMIT"), downstream);
        assert.deepEqual(decision, { kind: "retry" });
    }
    assert.equal(downstreamClaims, 4, "downstream llm-retry keeps ownership below threshold");
    const resolved = await runRequest(listeners, { provider: "A", model: "a-1" });
    assert.equal(resolved.provider, "A", "healthy A keeps serving");
});

test("Test 2: five consecutive failures mark the model unavailable and switch to B", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const agent = makeAgent();
    const decision = await driveToSwitch(listeners, agent, "A");
    assert.deepEqual(decision, { kind: "retry" });
    assert.equal(switchLogCount(logs), 1, "exactly one host-log switch record (from A)");
    assert.ok(logs.some(([, m]) => m.includes('switching to "B" (b-1)')), "log names target provider and model");
    assert.ok(logs.some(([, m]) => m.includes('"A" parked for 60s after 5 consecutive')), "warn log names the marked provider and its cooldown");
    assert.equal(agent.session.appended.length, 0, "no session events are ever written (S0 hazard mitigation)");
    const routed = await runRequest(listeners, { provider: "A", model: "a-1", maxTokens: 1024 });
    assert.equal(routed.provider, "B");
    assert.equal(routed.model, "b-1");
});

test("Test 3: success resets the consecutive failure counter", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const agent = makeAgent();
    for (let i = 0; i < 3; i++) await runError(listeners, errorPayload(agent, "A", "TIMEOUT"));
    emitSessionEvent(listeners, { type: "assistant/message", data: { message: { source: { provider: "A", model: "a-1" } } } });
    for (let i = 0; i < 4; i++) {
        const decision = await runError(listeners, errorPayload(agent, "A", "TIMEOUT"));
        assert.deepEqual(decision, { kind: "retry" });
    }
    assert.equal(switchLogCount(logs), 0, "no switch before the fresh streak reaches five");
    await runError(listeners, errorPayload(agent, "A", "TIMEOUT"));
    assert.equal(switchLogCount(logs), 1, "fresh streak of five triggers the switch");
});

test("Test 4: task continues on B after failover without touching session history", async () => {
    const { ctx, listeners } = makeCtx();
    let clock = 1000;
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const agent = makeAgent();
    await driveToSwitch(listeners, agent, "A");
    for (let step = 4; step < 8; step++) {
        const routed = await runRequest(listeners, { provider: "A", model: "a-1" });
        assert.equal(routed.provider, "B");
    }
    assert.equal(agent.session.appended.length, 0, "failover never writes session events");
});

test("Test 5: A -> B -> C all failing ends with a clear terminal stand-down", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { models: [{ provider: "A", model: "a-1" }, { provider: "B", model: "b-1" }, { provider: "C", model: "c-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const agent = makeAgent();
    await driveToSwitch(listeners, agent, "A");
    await driveToSwitch(listeners, agent, "B");
    const decision = await driveToSwitch(listeners, agent, "C");
    assert.equal(decision, undefined, "stand down so the original LlmError surfaces");
    assert.equal(agent.session.appended.length, 0, "stand-down writes no session events");
    assert.ok(logs.some(([lvl, m]) => lvl === "error" && m.includes("no healthy target left")));
    assert.ok(logs.some(([lvl, m]) => lvl === "error" && m.includes("Earliest recovery:")), "the terminal error names when the first provider comes back");
});

test("Test 6: cooldown expiry admits the provider as a probe, and the probe decides", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { cooldownSeconds: 60, models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const agent = makeAgent();
    await driveToSwitch(listeners, agent, "A");
    let routed = await runRequest(listeners, { provider: "A", model: "a-1" });
    assert.equal(routed.provider, "B", "parked A is bypassed");
    clock += 61000;
    routed = await runRequest(listeners, { provider: "A", model: "a-1" });
    assert.equal(routed.provider, "A", "expiry admits A as a half-open probe rather than declaring it healthy");
    assert.ok(logs.some(([, m]) => m.includes("cooldown elapsed") && m.includes('"A"')));
    // The probe failed: re-parked at once, without re-earning the threshold,
    // and the next cooldown is longer than the last one.
    const switchesBefore = switchLogCount(logs);
    const probeFailed = await runError(listeners, errorPayload(agent, "A", "SERVER"));
    assert.deepEqual(probeFailed, { kind: "retry" }, "a failed probe switches immediately");
    assert.equal(switchLogCount(logs), switchesBefore + 1, "exactly one switch record for the failed probe");
    assert.ok(logs.some(([, m]) => m.includes('provider "A" parked for 2m after a failed probe')), "the re-park escalates 60s -> 2m");
    // A proven success clears the ledger and forfeits the escalation penalty.
    clock += 121000;
    await runRequest(listeners, { provider: "A", model: "a-1" });
    emitSessionEvent(listeners, { type: "assistant/message", data: { message: { source: { provider: "A", model: "a-1" } } } });
    assert.ok(logs.some(([, m]) => m.includes('provider "A" probe succeeded')));
    const switchesAfter = switchLogCount(logs);
    // A real attempt is always preceded by a request build, and that build is
    // what settles the probe generation (see rewriteRoute): the next failure is
    // therefore the first of a fresh cycle, not a late probe result.
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "A");
    for (let i = 1; i < 5; i++) await runError(listeners, errorPayload(agent, "A", "SERVER"));
    assert.equal(switchLogCount(logs), switchesAfter, "fresh streak starts at zero after a proven recovery");
});

test("Test 7: permanent errors never fail over; every transient class does", async () => {
    const { ctx, listeners } = makeCtx();
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { sleep: NO_SLEEP });
    const agent = makeAgent();
    const ineligible = ["AUTH", "INVALID_CREDENTIAL", "INVALID_REQUEST", "CONTEXT_WINDOW_EXCEEDED", "UNKNOWN_MODEL", "UNSUPPORTED_CONTENT", "ABORTED"];
    for (const code of ineligible) {
        for (let i = 0; i < 8; i++) {
            const decision = await runError(listeners, errorPayload(agent, "A", code));
            assert.equal(decision, undefined, code + " passes straight through");
        }
    }
    assert.equal(agent.session.appended.length, 0, "permanent errors leave no trace at all");
    for (const code of ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "STREAM_CLOSED"]) {
        const fresh = makeCtx();
        apply(fresh.ctx, { models: [{ provider: "B", model: "b-1" }] }, { sleep: NO_SLEEP });
        const decision = await driveToSwitch(fresh.listeners, makeAgent(), "A", code);
        assert.deepEqual(decision, { kind: "retry" }, code + " switches after threshold");
    }
});

test("Test 7c: a quota wall switches on the FIRST failure and parks for hours", async () => {
    const { ctx, listeners, logs } = makeCtx();
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { sleep: NO_SLEEP });
    const agent = makeAgent();
    const decision = await runError(listeners, errorPayload(agent, "A", "QUOTA"));
    assert.deepEqual(decision, { kind: "retry" }, "a wall does not wait for the consecutive-failure threshold");
    assert.equal(switchLogCount(logs), 1, "exactly one switch record");
    assert.ok(logs.some(([, m]) => m.includes('provider "A" parked for 4h (quota-code)')), "the wall park is hours and names its source");
});

test("Test 7d: a provider-published reset is honoured verbatim, a short one stays a blip", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const agent = makeAgent();
    const wall = await runError(listeners, {
        agent, turn: 1, step: 1, provider: "A",
        failure: { code: "RATE_LIMIT", message: "slow down", providerRetryAfterMs: 5 * 3600 * 1000 },
        retryPolicy: undefined, signal: undefined
    });
    assert.deepEqual(wall, { kind: "retry" }, "a published 5h reset is a wall: switch now");
    assert.ok(logs.some(([, m]) => m.includes('provider "A" parked for 5h (the provider\'s own reset)')), "the published reset is used verbatim");
    clock += 4 * 3600 * 1000;
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "B", "still parked four hours later");
    clock += 2 * 3600 * 1000;
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "A", "admitted as a probe once the published reset passes");

    const blipCtx = makeCtx();
    apply(blipCtx.ctx, { models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const blip = await runError(blipCtx.listeners, {
        agent: makeAgent(), turn: 1, step: 1, provider: "A",
        failure: { code: "RATE_LIMIT", message: "bursty", providerRetryAfterMs: 1500 },
        retryPolicy: undefined, signal: undefined
    });
    assert.deepEqual(blip, { kind: "retry" });
    assert.ok(!blipCtx.logs.some(([, m]) => m.includes("parked for")), "a 1.5s reset is a blip: no park, the threshold rules apply");
});
test("Test 7b: per-class toggles disable individual transient classes", async () => {
    const { ctx, listeners } = makeCtx();
    apply(ctx, { failoverOnRateLimit: false, models: [{ provider: "B", model: "b-1" }] });
    const agent = makeAgent();
    for (let i = 0; i < 8; i++) {
        const decision = await runError(listeners, errorPayload(agent, "A", "RATE_LIMIT"));
        assert.equal(decision, undefined, "disabled class passes through even at high counts");
    }
    assert.equal(agent.session.appended.length, 0);
});

test("Test 8: mid-stream SSE interruption fails over cleanly with bounded logging", async () => {
    const { ctx, listeners, logs } = makeCtx();
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { sleep: NO_SLEEP });
    const agent = makeAgent();
    const decision = await driveToSwitch(listeners, agent, "A", "STREAM_CLOSED");
    assert.deepEqual(decision, { kind: "retry" });
    const switchLine = logs.find(([, m]) => m.includes('temporarily switching to "B"'));
    assert.ok(switchLine, "switch is announced in host log");
    assert.ok(switchLine[1].length <= 350, "error text truncated before logging (bounded line)");
    assert.equal(agent.session.appended.length, 0, "no session events for mid-stream failover");
});

test("Test 9: rerouted requests preserve unrelated fields and drop inherited effort", async () => {
    const { ctx, listeners } = makeCtx();
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { sleep: NO_SLEEP });
    const agent = makeAgent();
    await driveToSwitch(listeners, agent, "A");
    const routed = await runRequest(listeners, { provider: "A", model: "a-1", maxTokens: 4096, reasoningEffort: "high" });
    assert.deepEqual(routed, { provider: "B", model: "b-1", maxTokens: 4096 }, "provider/model replaced; generic limits kept; stale effort dropped");
});

test("Test 10: disabled failover preserves original behavior exactly", async () => {
    const { ctx, listeners } = makeCtx();
    apply(ctx, { enabled: false, models: [{ provider: "B", model: "b-1" }] });
    const agent = makeAgent();
    for (let i = 0; i < 12; i++) {
        const decision = await runError(listeners, errorPayload(agent, "A", "RATE_LIMIT"));
        assert.equal(decision, undefined, "every failure flows to the original terminal path");
    }
    const routed = await runRequest(listeners, { provider: "A", model: "a-1" });
    assert.deepEqual(routed, { provider: "A", model: "a-1" });
    assert.equal(agent.session.appended.length, 0);
});

test("Test 11: unknown config keys are reported and ignored", () => {
    const { ctx, logs } = makeCtx();
    assert.doesNotThrow(() => apply(ctx, { modles: [], models: [{ provider: "B", model: "b-1" }] }), "misconfigured keys degrade instead of throwing");
    assert.ok(logs.some(([, m]) => m.includes('ignored unknown key "modles"')), "unknown key surfaces as a warning");
    assert.doesNotThrow(() => apply(makeCtx().ctx, undefined), "undefined config falls back to safe defaults");
});

test("Test 12: per-turn switch cap stops infinite ping-pong within one turn", async () => {
    const { ctx, listeners } = makeCtx();
    let clock = 1000;
    apply(ctx, { maxSwitchesPerTurn: 1, models: [{ provider: "B", model: "b-1" }, { provider: "C", model: "c-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const agent = makeAgent();
    await driveToSwitch(listeners, agent, "A");
    const decision = await driveToSwitch(listeners, agent, "B");
    assert.equal(decision, undefined, "cap reached: stand down instead of switching again");
    emitStatus(listeners, agent, "idle");
    const revived = await runError(listeners, errorPayload(agent, "B", "RATE_LIMIT"));
    assert.deepEqual(revived, { kind: "retry" }, "idle reset re-arms the budget (a late failure on the parked provider is switchable again)");
});

test("Test 13: autoRecover=false keeps the failed provider out until proven healthy", async () => {
    // Time alone never restores it.
    {
        const { ctx, listeners } = makeCtx();
        let clock = 1000;
        apply(ctx, { autoRecover: false, cooldownSeconds: 60, models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
        await driveToSwitch(listeners, makeAgent(), "A");
        clock += 3600000;
        assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "B", "no time-based recovery when autoRecover is off");
    }
    // A proven success does — with no reroute in the same window, so the
    // attribution is conclusive (the ambiguity guard refuses inherited routes).
    {
        const { ctx, listeners, logs } = makeCtx();
        let clock = 1000;
        apply(ctx, { autoRecover: false, cooldownSeconds: 60, models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
        await driveToSwitch(listeners, makeAgent(), "A");
        emitSessionEvent(listeners, { type: "assistant/message", data: { message: { source: { provider: "A", model: "a-1" } } } });
        assert.ok(logs.some(([, m]) => m.includes('provider "A" recovered')), "proof-of-life clears the ledger");
        assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "A", "active proof-of-life restores A immediately");
    }
});

test("Test 13b: a success arriving right after our own reroute is refused (ambiguity guard)", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { cooldownSeconds: 60, models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    await driveToSwitch(listeners, makeAgent(), "A");
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "B", "A parked, request rerouted away");
    emitSessionEvent(listeners, { type: "assistant/message", data: { message: { source: { provider: "A", model: "a-1" } } } });
    assert.ok(logs.some(([, m]) => m.includes("ignoring a success attributed to")), "the inherited attribution is rejected");
    assert.ok(!logs.some(([, m]) => m.includes('provider "A" recovered')), "the cooldown stands");
});

test("Test 14: activation never throws - garbage config degrades to safe defaults", async () => {
    const { ctx, listeners } = makeCtx();
    let clock = 1000;
    assert.doesNotThrow(() => apply(ctx, { modles: [], maxConsecutiveFailures: "five", models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP }));
    const agent = makeAgent();
    const decision = await driveToSwitch(listeners, agent, "A");
    assert.deepEqual(decision, { kind: "retry" }, "sanitized config keeps the plugin functional");
});

test("Test 15: internal listener faults bypass failover instead of breaking requests", async () => {
    const { ctx, listeners } = makeCtx();
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { sleep: NO_SLEEP });
    const entry = (listeners.get("agent/request-error") ?? [])[0];
    let downstreamCalls = 0;
    const decision = await entry.cb({ agent: undefined, provider: undefined, failure: undefined, signal: undefined }, async () => { downstreamCalls += 1; return undefined; });
    assert.equal(decision, undefined, "malformed input falls through to the original terminal path");
    assert.equal(downstreamCalls, 1, "downstream stack still consulted exactly once");
});

test("Test 16: missing or empty models pool stays fully inert", async () => {
    for (const config of [{}, { models: [] }]) {
        const { ctx, listeners, logs } = makeCtx();
        assert.doesNotThrow(() => apply(ctx, config), "activation survives a missing/empty pool without internal errors");
        assert.ok(logs.some(([, m]) => m.includes("staying inert")), "inert state is announced in the log");
        const agent = makeAgent();
        for (let i = 0; i < 8; i++) {
            const decision = await runError(listeners, errorPayload(agent, "A", "RATE_LIMIT"));
            assert.equal(decision, undefined, "no pool -> original terminal path, no self-retry");
        }
        assert.equal(agent.session.appended.length, 0, "no spurious session events without a pool");
        const routed = await runRequest(listeners, { provider: "A", model: "a-1" });
        assert.deepEqual(routed, { provider: "A", model: "a-1" }, "routing passes through untouched");
    }
});

test("Test 17: downstream non-retry decisions are honoured verbatim, never overwritten", async () => {
    const { ctx, listeners } = makeCtx();
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { sleep: NO_SLEEP });
    const agent = makeAgent();
    const custom = { kind: "escalate", reason: "downstream policy" };
    const decision = await runError(listeners, errorPayload(agent, "A", "RATE_LIMIT"), async () => custom);
    assert.equal(decision, custom, "any claimed downstream decision passes through unchanged");
});

test("Test 18: cooldownSeconds of zero is rejected and falls back to the default", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { cooldownSeconds: 0, models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    assert.ok(logs.some(([, m]) => m.includes('"cooldownSeconds" must be a number > 0')), "zero cooldown is reported");
    const agent = makeAgent();
    await driveToSwitch(listeners, agent, "A");
    let routed = await runRequest(listeners, { provider: "A", model: "a-1" });
    assert.equal(routed.provider, "B", "default 60s cooldown keeps A out of the pool");
    clock += 61000;
    routed = await runRequest(listeners, { provider: "A", model: "a-1" });
    assert.equal(routed.provider, "A", "default cooldown expires on schedule (no zero-length oscillation)");
});

//#region v0.2.0-rc.2 regressions

/** Count park records for one provider; the deadline is only ever set where one is logged. */
function parkLogCount(logs, provider) {
    return logs.filter(([, m]) => m.includes(`"${provider}" parked for`)).length;
}

test("Test 19: late failures on an already-parked provider never extend its cooldown", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const agent = makeAgent();
    assert.deepEqual(await runError(listeners, errorPayload(agent, "A", "QUOTA")), { kind: "retry" }, "the first quota wall parks A");
    assert.equal(parkLogCount(logs, "A"), 1);
    clock += 60 * 1000;
    // A later report about the same provider (an in-flight request that was
    // built before the park) is old news: it must not re-park A.
    const late = await runError(listeners, errorPayload(agent, "A", "QUOTA"));
    assert.equal(parkLogCount(logs, "A"), 1, "no second park record, so no recomputed deadline");
    assert.deepEqual(late, { kind: "retry" }, "the request still moves to a healthy target");
    assert.ok(logs.some(([, m]) => m.includes('"A"') && m.includes("already parked")), "the late failure is logged as already parked");
    // The original 4h deadline stands.
    clock += 4 * 3600 * 1000 - 61 * 1000;
    assert.equal(parkLogCount(logs, "A"), 1, "still no re-park after four hours of late reports");
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "B", "the original deadline still holds");
    clock += 2000;
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "A", "admitted as a probe right on schedule");
});

test("Test 19b: a late failure with no healthy target stands down instead of re-parking", async () => {
    const { ctx, listeners, logs } = makeCtx();
    apply(ctx, { models: [{ provider: "A", model: "a-1" }] }, { sleep: NO_SLEEP });
    const agent = makeAgent();
    assert.equal(await runError(listeners, errorPayload(agent, "A", "QUOTA")), undefined, "the only provider parks and the listener stands down");
    const parks = parkLogCount(logs, "A");
    const stands = logs.filter(([, m]) => m.includes("no healthy target left")).length;
    assert.equal(await runError(listeners, errorPayload(agent, "A", "QUOTA")), undefined, "the late repeat stands down too");
    assert.equal(parkLogCount(logs, "A"), parks, "the deadline is not recomputed");
    assert.equal(logs.filter(([, m]) => m.includes("no healthy target left")).length, stands + 1, "the second stand-down is logged as such");
    assert.ok(logs.some(([, m]) => m.includes('"A" QUOTA while already parked')), "and it says the park already stands");
});

test("Test 20: the ambiguity guard covers the whole parking period, not just 60s", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const success = () => emitSessionEvent(listeners, { type: "assistant/message", data: { message: { source: { provider: "A", model: "a-1" } } } });
    await runError(listeners, errorPayload(makeAgent(), "A", "QUOTA"));
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "B", "A parked, the request is rerouted to B");
    for (const advance of [61 * 1000, 3600 * 1000]) {
        clock += advance;
        success();
        assert.ok(logs.some(([, m]) => m.includes("ignoring a success attributed to")), `a success ${advance}ms after the reroute is refused`);
        assert.ok(!logs.some(([, m]) => m.includes('provider "A" recovered')), "the wall cooldown stands");
        assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "B", "A stays parked");
    }
    clock += 4 * 3600 * 1000;
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "A", "the real probe is still admitted on schedule");
    success();
    assert.ok(logs.some(([, m]) => m.includes('provider "A" probe succeeded')), "a genuine probe success still clears the ledger");
});

test("Test 21: with autoRecover off a reroute makes every later success ambiguous", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { autoRecover: false, models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    await runError(listeners, errorPayload(makeAgent(), "A", "QUOTA"));
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "B", "A parked indefinitely, the request is rerouted");
    clock += 3600 * 1000;
    emitSessionEvent(listeners, { type: "assistant/message", data: { message: { source: { provider: "A", model: "a-1" } } } });
    assert.ok(logs.some(([, m]) => m.includes("ignoring a success attributed to")), "the indefinite park is not lifted by an inherited success");
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "B", "A is still out of the pool");
});

test("Test 22: a same-generation probe that fails late is a failed probe, not a fresh streak", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { cooldownSeconds: 60, models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const agent = makeAgent();
    await driveToSwitch(listeners, agent, "A");
    clock += 61 * 1000;
    // Two concurrent probes of the same generation are admitted (this seam
    // cannot cap probe concurrency; it must still judge both results).
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "A");
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "A");
    emitSessionEvent(listeners, { type: "assistant/message", data: { message: { source: { provider: "A", model: "a-1" } } } });
    assert.ok(logs.some(([, m]) => m.includes('provider "A" probe succeeded')), "the first probe reports success");
    const switches = switchLogCount(logs);
    const mark = logs.length;
    const late = await runError(listeners, errorPayload(agent, "A", "SERVER"));
    assert.deepEqual(late, { kind: "retry" }, "the late failure of the same generation switches immediately");
    assert.equal(switchLogCount(logs), switches + 1);
    assert.ok(logs.some(([, m]) => m.includes('"A" parked for 2m after a late same-generation probe failure')), "the re-park escalates exactly like a failed probe");
    assert.ok(!logs.slice(mark).some(([, m]) => m.includes("consecutive failure 1/5")), "it is never counted as a fresh first failure");
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "B", "A is out of the pool again");
});

test("Test 22b: a fresh request after a proven recovery starts a clean cycle", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { cooldownSeconds: 60, models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const agent = makeAgent();
    await driveToSwitch(listeners, agent, "A");
    clock += 61 * 1000;
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "A", "probe admitted");
    emitSessionEvent(listeners, { type: "assistant/message", data: { message: { source: { provider: "A", model: "a-1" } } } });
    // A brand-new request is built on the recovered provider: the previous
    // generation is settled, so a failure on it counts normally.
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "A");
    const switches = switchLogCount(logs);
    const mark = logs.length;
    const decision = await runError(listeners, errorPayload(agent, "A", "SERVER"));
    assert.deepEqual(decision, { kind: "retry" }, "below the threshold the downstream stack keeps ownership");
    assert.equal(switchLogCount(logs), switches, "one failure is not a probe failure");
    assert.ok(logs.slice(mark).some(([, m]) => m.includes("consecutive failure 1/5")), "the fresh cycle counts from one");
});

test("Test 23: the latest trusted reset wins over an earlier short signal", async () => {
    const nowMs = Date.parse("2026-09-25T00:00:00Z");
    const plan = resolveResetPlan({
        code: "RATE_LIMIT",
        message: "slow down; retry again in 30 seconds; usage limit for your plan has been reached; resets at 2026-09-25T03:00:00Z",
        providerRetryAfterMs: 5000
    }, nowMs);
    assert.equal(plan.wall, true, "a long window is still a wall");
    assert.equal(plan.parkMs, 3 * 3600 * 1000, "the latest signal wins, not the first one seen");
    assert.equal(plan.source, "reset-stamp", "the source names the signal actually used");
});

test("Test 24: an upstream-published reset is not clamped by maxCooldownSeconds", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { maxCooldownSeconds: 60, models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const decision = await runError(listeners, {
        agent: makeAgent(), turn: 1, step: 1, provider: "A",
        failure: { code: "RATE_LIMIT", message: "slow down", providerRetryAfterMs: 5 * 3600 * 1000 },
        retryPolicy: undefined, signal: undefined
    });
    assert.deepEqual(decision, { kind: "retry" }, "a published 5h reset is a wall");
    assert.ok(logs.some(([, m]) => m.includes("parked for 5h (the provider's own reset)")), "the published window is used verbatim, not clamped to the local 60s cap");
    clock += 61 * 1000;
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "B", "still parked a minute later");
    clock += 5 * 3600 * 1000;
    assert.equal((await runRequest(listeners, { provider: "A", model: "a-1" })).provider, "A", "admitted as a probe once the published reset passes");
});

test("Test 25: a short Retry-After is not logged as the provider's own reset", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { now: () => clock, sleep: NO_SLEEP });
    const agent = makeAgent();
    let decision;
    for (let i = 0; i < 5; i++) {
        decision = await runError(listeners, {
            agent, turn: 7, step: 3, provider: "A",
            failure: { code: "RATE_LIMIT", message: "bursty", providerRetryAfterMs: 1500 },
            retryPolicy: undefined, signal: undefined
        });
    }
    assert.deepEqual(decision, { kind: "retry" }, "the threshold still switches");
    assert.ok(logs.some(([, m]) => m.includes('provider "A" parked for 60s after 5 consecutive RATE_LIMIT failures')), "the local 60s penalty is what was applied");
    assert.ok(!logs.some(([, m]) => m.includes("the provider's own reset")), "the log does not claim an upstream reset it did not use");
});

test("Test 26: the self-fallback wait respects the provider's Retry-After", async () => {
    const slept = [];
    const { ctx, listeners } = makeCtx();
    apply(ctx, { models: [{ provider: "B", model: "b-1" }] }, { sleep: async (ms) => { slept.push(ms); } });
    await runError(listeners, {
        agent: makeAgent(), turn: 1, step: 1, provider: "A",
        failure: { code: "RATE_LIMIT", message: "slow down", providerRetryAfterMs: 30000 },
        retryPolicy: undefined, signal: undefined
    }, async () => undefined);
    assert.equal(slept.length, 1, "the fallback retry waited once");
    assert.ok(slept[0] >= 30000, `waited at least the published 30s (got ${slept[0]}ms)`);

    const control = [];
    const plain = makeCtx();
    apply(plain.ctx, { models: [{ provider: "B", model: "b-1" }] }, { sleep: async (ms) => { control.push(ms); } });
    await runError(plain.listeners, errorPayload(makeAgent(), "A", "RATE_LIMIT"), async () => undefined);
    assert.deepEqual(control, [250], "without a published wait the bounded exponential backoff is unchanged");
});

test("Test 27: the per-turn switch budget survives a turn longer than its TTL", async () => {
    const { ctx, listeners, logs } = makeCtx();
    let clock = 1000;
    const models = ["B", "C", "D", "E"].map((p) => ({ provider: p, model: p.toLowerCase() + "-1" }));
    apply(ctx, { maxSwitchesPerTurn: 3, models }, { now: () => clock, sleep: NO_SLEEP });
    const agent = makeAgent();
    assert.deepEqual(await runError(listeners, errorPayload(agent, "A", "QUOTA")), { kind: "retry" }, "first switch of the turn");
    assert.deepEqual(await runError(listeners, errorPayload(agent, "B", "QUOTA")), { kind: "retry" }, "second switch of the turn");
    clock += 2 * 3600 * 1000;
    assert.deepEqual(await runError(listeners, errorPayload(agent, "C", "QUOTA")), { kind: "retry" }, "third switch of the same, now hours-old, turn");
    const decision = await runError(listeners, errorPayload(agent, "D", "QUOTA"));
    assert.equal(decision, undefined, "the fourth switch of a long turn is refused: the budget never expires mid-turn");
    assert.ok(logs.some(([lvl, m]) => lvl === "error" && m.includes("switch budget exhausted")), "the stand-down says why");
    assert.equal(switchLogCount(logs), 3, "exactly the configured number of switches");
});

test("Test 28: indefinite parks are named in the terminal dump instead of claiming health", async () => {
    const { ctx, listeners, logs } = makeCtx();
    apply(ctx, { autoRecover: false, models: [{ provider: "B", model: "b-1" }] }, { sleep: NO_SLEEP });
    const agent = makeAgent();
    await runError(listeners, errorPayload(agent, "A", "QUOTA"));
    assert.equal(await runError(listeners, errorPayload(agent, "B", "QUOTA")), undefined, "no target left: stand down");
    const dump = logs.find(([lvl, m]) => lvl === "error" && m.includes("provider states:"));
    assert.ok(dump !== undefined, "the terminal log dumps provider states");
    assert.ok(dump[1].includes("A=parked(indefinitely"), "A is reported as parked indefinitely");
    assert.ok(dump[1].includes("B=parked(indefinitely"), "B is reported as parked indefinitely");
    assert.ok(!dump[1].includes("every configured provider is healthy"), "it never claims all providers are healthy");
});
//#endregion
