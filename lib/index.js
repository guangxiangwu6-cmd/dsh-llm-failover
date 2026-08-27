import z from "@deepseek-ai/schemastery";
//#region failure classification
/**
* Failure classes that justify leaving the current provider, each owned by one
* config toggle. Codes follow the provider-neutral harness set:
*
* - RATE_LIMIT      HTTP 429 / provider rate limiting
* - SERVER          HTTP 5xx (500/502/503/504 gateway timeouts included)
* - TIMEOUT         request/connection/idle-watchdog timeouts
* - TRANSPORT       fetch failed: DNS, connection reset/refused, proxy/link errors
* - STREAM_CLOSED   SSE stream interrupted before completion (mid-stream outage)
* - EMPTY_RESPONSE  degenerate completion with no durable content (safe to repeat)
* - QUOTA           exhausted account quota/balance on this provider
*
* Everything else (AUTH, INVALID_CREDENTIAL, INVALID_REQUEST,
* CONTEXT_WINDOW_EXCEEDED, UNKNOWN_MODEL, UNSUPPORTED_*, ABORTED, ...) is a
* permanent or caller-owned failure and is never failed over.
*/

/** Failure code -> owning config toggle. */
const FAILover_CODE_TOGGLES = {
    RATE_LIMIT: "failoverOnRateLimit",
    SERVER: "failoverOnServerError",
    TIMEOUT: "failoverOnTimeout",
    TRANSPORT: "failoverOnTransportError",
    STREAM_CLOSED: "failoverOnStreamInterrupted",
    EMPTY_RESPONSE: "failoverOnEmptyResponse",
    QUOTA: "failoverOnQuota"
};
/**
* @param code - canonical harness failure code.
* @param config - resolved plugin config.
* @returns true when the code may trigger failover.
*/
function isFailoverEligible(code, config) {
    const toggle = FAILover_CODE_TOGGLES[code];
    return toggle !== undefined && config[toggle] === true;
}
//#endregion
//#region lib/index.js
/**
* Provider-level model failover for the DeepSeek Harness.
*
* Composes with the existing recovery stack as the OUTERMOST listener on the
* agent loop's request-recovery waterfall (`agent/request-error`) and the
* outermost filter on the route-proposal waterfall (`agent/request`):
*
* 1. Every failover-eligible failure increments a per-provider consecutive
*    failure counter. Below `maxConsecutiveFailures` the downstream stack
*    keeps ownership (typically llm-retry's bounded backoff), so existing
*    same-provider retry behavior is unchanged.
* 2. At the threshold the provider is marked unavailable for
*    `cooldownSeconds`, the next healthy entry of the priority pool is
*    selected, and the listener returns `{ kind: "retry" }` itself — bypassing
*    further same-provider retries.
* 3. While a provider is marked, every request build resolves through the
*    `agent/request` listener, which rewrites an unhealthy route to the best
*    healthy pool entry. Later steps of the same turn continue seamlessly on
*    the replacement model; context, tool state, and task progress live in the
*    durable session and never depend on which provider serves a step.
* 4. Recovery is dual-path: lazily when the cooldown elapses during any later
*    health check, and actively as soon as an assistant message proves the
*    provider completed a response again.
* 5. When no healthy target remains (or the per-turn switch cap is hit) the
*    listener stands down: the original LlmError surfaces ("all models
*    unavailable") instead of an infinite switch loop.
*
* Failed attempts close their step without materializing partial messages —
* the same guarantee llm-retry documents — so no duplicated output can leak
* into derived history after a failover. Decision trail lives exclusively in
* host logs (ctx.logger): session events are never written, because an event
* type outside the harness vocabulary makes a persisted log unopenable on
* reload (verified experimentally; see README observability section).
*
* @module @deepseek-ai/dsh-llm-failover
*/
const name = "llm-failover";
const inject = ["agents"];
const DEFAULTS = {
    enabled: true,
    models: [],
    maxConsecutiveFailures: 5,
    cooldownSeconds: 60,
    autoRecover: true,
    maxSwitchesPerTurn: 8,
    failoverOnRateLimit: true,
    failoverOnTimeout: true,
    failoverOnServerError: true,
    failoverOnTransportError: true,
    failoverOnStreamInterrupted: true,
    failoverOnEmptyResponse: false,
    failoverOnQuota: false
};
/** Executor config keys; anything else is a typo reported and ignored by {@link sanitizeConfig}. */
const KNOWN_KEYS = new Set([
    ...Object.keys(DEFAULTS),
    "models"
]);
/**
* Loader-facing schema: deliberately PERMISSIVE. cordis validates every
* plugin row against its exported Config before activation, and one rejection
* fails the whole plugin tree at boot — strictness here would be a startup
* hazard, not a safety net. Real validation lives in {@link sanitizeConfig},
* which can only degrade to defaults plus warnings.
*/
const Config = z.object({});
/**
* Tolerant runtime configuration path: unknown keys are reported and ignored,
* schema violations fall back to defaults. A misconfigured deployment must
* degrade to an inert-but-boot-safe plugin, never threaten host startup.
*/
const BOOLEAN_FIELDS = new Set([
    "enabled", "autoRecover", "failoverOnRateLimit", "failoverOnTimeout",
    "failoverOnServerError", "failoverOnTransportError", "failoverOnStreamInterrupted",
    "failoverOnEmptyResponse", "failoverOnQuota"
]);
const INTEGER_FIELDS = new Set(["maxConsecutiveFailures", "maxSwitchesPerTurn"]);
/** Backoff bounds for the self-fallback retry used when no downstream policy claims a failure. */
const FALLBACK_RETRY_BASE_MS = 250;
const FALLBACK_RETRY_MAX_MS = 2000;
/** Per-turn switch budget entries idle longer than this are swept lazily (agent may never signal "idle"). */
const TURN_BUDGET_TTL_MS = 60 * 60 * 1000;
/**
 * The schema layer fills defaults but does NOT hard-reject mistyped scalars,
 * so every field is re-checked here against its declared shape before use.
 */
function sanitizeConfig(config, logger) {
    const problems = [];
    const cfg = { ...DEFAULTS };
    if (config !== undefined && config !== null && (typeof config !== "object" || Array.isArray(config))) {
        problems.push("config must be a mapping; using defaults");
        return finishSanitize(cfg, problems, logger);
    }
    for (const [key, value] of Object.entries(config ?? {})) {
        if (!KNOWN_KEYS.has(key)) {
            problems.push(`ignored unknown key "${key}"`);
            continue;
        }
        if (key === "models") {
            if (Array.isArray(value)) {
                const routes = value.filter((entry) => entry !== null && typeof entry === "object"
                    && typeof entry.provider === "string" && entry.provider !== ""
                    && typeof entry.model === "string" && entry.model !== "");
                if (routes.length !== value.length) problems.push(`dropped ${value.length - routes.length} malformed models entry/entries`);
                cfg.models = routes.map((entry) => ({ provider: entry.provider, model: entry.model }));
            } else {
                problems.push("models must be an array; ignoring it");
            }
            continue;
        }
        if (BOOLEAN_FIELDS.has(key)) {
            if (typeof value === "boolean") cfg[key] = value;
            else problems.push(`"${key}" must be a boolean; using the default`);
            continue;
        }
        if (INTEGER_FIELDS.has(key)) {
            if (typeof value === "number" && Number.isInteger(value) && value >= 1) cfg[key] = value;
            else problems.push(`"${key}" must be an integer >= 1; using the default`);
            continue;
        }
        if (key === "cooldownSeconds") {
            // Strictly positive: a zero-length cooldown expires in the same
            // instant it is set, which oscillates routing between the failed
            // provider and its replacement instead of holding a cooldown.
            if (typeof value === "number" && Number.isFinite(value) && value > 0) cfg[key] = value;
            else problems.push("\"cooldownSeconds\" must be a number > 0; using the default");
            continue;
        }
    }
    return finishSanitize(cfg, problems, logger);
}
function finishSanitize(cfg, problems, logger) {
    for (const problem of problems) {
        try {
            logger.warn(`llm-failover: ${problem}; falling back to safe defaults where applicable`);
        } catch {}
    }
    return cfg;
}
/**
* Truncate provider error text for logs and actively mask anything that could
* carry a credential: URL userinfo (http://user:pass@host), Bearer tokens, and
* key/token query parameters. Adapters are expected to never include
* credentials, but log lines must not depend on that assumption holding.
*/
function brief(message) {
    const text = typeof message === "string" ? message : String(message ?? "");
    const scrubbed = text
        .replace(/\/\/[^@\s/]+@/g, "//***@")
        .replace(/(bearer\s+)\S+/gi, "$1***")
        .replace(/((?:api[-_]?key|access[-_]?token|token|key)=)[^&\s]+/gi, "$1***");
    return scrubbed.length > 200 ? scrubbed.slice(0, 197) + "..." : scrubbed;
}
/**
* Install provider failover on the agent loop's recovery extension points.
* @param ctx - plugin context providing `on`, `effect`, and `logger`.
* @param config - executor config (validated against {@link Config}).
* @param internals - non-serializable deterministic hooks for tests.
*/
function apply(ctx, config = {}, internals = {}) {
    try {
        return applyFailover(ctx, config, internals);
    } catch (error) {
        // Last-resort containment: a broken activation must degrade to an
        // inert plugin, never propagate into host startup.
        try {
            ctx?.logger?.error?.(`llm-failover: activation failed; the plugin stayed inert and host startup is unaffected: ${error instanceof Error ? error.message : String(error)}`);
        } catch {}
        return undefined;
    }
}
/**
* Real installation body, split out so {@link apply} can contain any failure.
* @param ctx - plugin context providing `on`, `effect`, and `logger`.
* @param config - executor config (tolerantly sanitized).
* @param internals - non-serializable deterministic hooks for tests.
*/
function applyFailover(ctx, config = {}, internals = {}) {
    const cfg = sanitizeConfig(config, ctx.logger);
    const now = internals.now ?? (() => Date.now());
    const sleep = internals.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const lifetime = new AbortController();
    /** Per-provider health ledger. */
    const health = new Map();
    /** agentId -> { turn, count }: failover switches charged to one turn. */
    const turnSwitches = new Map();
    function providerState(provider) {
        let state = health.get(provider);
        if (state === undefined) {
            state = { failures: 0, unavailableUntil: undefined, announcedDown: false };
            health.set(provider, state);
        }
        return state;
    }
    /**
    * Health check with lazy cooldown expiry: an elapsed deadline re-enters the
    * provider into the pool right here, which is the periodic health check.
    */
    function isUnavailable(provider) {
        const state = health.get(provider);
        if (state?.unavailableUntil === undefined) return false;
        if (now() >= state.unavailableUntil) {
            if (cfg.autoRecover) ctx.logger.info(`llm-failover: provider "${provider}" cooldown elapsed; re-entering the model pool`);
            // Drop the ledger entry entirely: a fully healthy provider needs
            // no state, and deleting keeps the health map bounded by the
            // number of currently-degraded providers.
            health.delete(provider);
            return false;
        }
        return true;
    }
    function markUnavailable(provider) {
        const state = providerState(provider);
        state.failures = 0;
        state.unavailableUntil = cfg.autoRecover && cfg.cooldownSeconds > 0 ? now() + cfg.cooldownSeconds * 1000 : Number.POSITIVE_INFINITY;
        state.announcedDown = true;
    }
    function noteSuccess(provider) {
        const state = health.get(provider);
        if (state === undefined) return;
        const wasDegraded = state.unavailableUntil !== undefined || state.announcedDown || state.failures > 0;
        // See isUnavailable: fully recovered providers leave no ledger entry.
        health.delete(provider);
        if (wasDegraded) ctx.logger.info(`llm-failover: provider "${provider}" recovered and rejoined the model pool`);
    }
    /** Deduplicated priority pool. The failing provider is excluded by callers. */
    function pool() {
        const chain = [];
        const seen = new Set();
        for (const entry of cfg.models) {
            const key = entry.provider + "\u0000" + entry.model;
            if (seen.has(key)) continue;
            seen.add(key);
            chain.push({ provider: entry.provider, model: entry.model });
        }
        return chain;
    }
    function selectTarget(failedProvider) {
        for (const route of pool()) {
            if (route.provider === failedProvider) continue;
            if (isUnavailable(route.provider)) continue;
            return route;
        }
        return undefined;
    }
    function switchesThisTurn(agentId, turn) {
        const record = turnSwitches.get(agentId);
        return record !== undefined && record.turn === turn ? record.count : 0;
    }
    function chargeSwitch(agentId, turn) {
        const nowMs = now();
        // Sweep stale budgets whose agent never signalled "idle", so this map
        // stays bounded by the number of recently-active agents.
        for (const [id, record] of turnSwitches) {
            if (nowMs - record.at > TURN_BUDGET_TTL_MS) turnSwitches.delete(id);
        }
        const record = turnSwitches.get(agentId);
        if (record !== undefined && record.turn === turn) {
            record.count += 1;
            record.at = nowMs;
        } else {
            turnSwitches.set(agentId, { turn, count: 1, at: nowMs });
        }
    }
    // Outermost on request-error: the failover decision precedes llm-retry's claim.
    // Any internal fault degrades to pass-through: failover must never break a request.
    const disposeError = ctx.on("agent/request-error", async (payload, next) => {
        try {
            return await decideRecovery(payload, next);
        } catch (error) {
            try {
                ctx.logger.warn(`llm-failover: internal error during recovery decision; bypassing failover for this request: ${error instanceof Error ? error.message : String(error)}`);
            } catch {}
            return next();
        }
    }, { prepend: true });
    async function decideRecovery(payload, next) {
        const { agent, turn, provider, failure } = payload;
        if (!cfg.enabled || lifetime.signal.aborted) return next();
        if (cfg.models.length === 0) return next();
        if (!isFailoverEligible(failure.code, cfg)) return next();
        const state = providerState(provider);
        state.failures += 1;
        const count = state.failures;
        ctx.logger.warn(`llm-failover: provider "${provider}" request failed (${failure.code}): consecutive failure ${count}/${cfg.maxConsecutiveFailures}: ${brief(failure.message)}`);
        if (count < cfg.maxConsecutiveFailures) {
            const decision = await next();
            // Below threshold the downstream recovery stack (llm-retry backoff,
            // compaction overflow handling) keeps same-provider ownership. ANY
            // downstream decision is honoured verbatim, not just "retry".
            // The abort signal is re-read here: it may have fired during next().
            if (decision !== undefined || payload.signal?.aborted === true) return decision;
            // No downstream policy claimed the failure: fall back to our own
            // threshold-bounded retry with bounded backoff, so deployments
            // without llm-retry neither die on the first transient error nor
            // hammer an already rate-limited provider in a zero-delay hot loop.
            await sleep(Math.min(FALLBACK_RETRY_BASE_MS * 2 ** (count - 1), FALLBACK_RETRY_MAX_MS));
            return { kind: "retry" };
        }
        // Threshold reached: take over from any downstream budget.
        const agentId = agent?.id;
        if (agentId === undefined || agentId === null) {
            // Guard BEFORE mutating any state: a bypassed decision must never
            // leave the provider half-marked without a switch decision.
            ctx.logger.warn(`llm-failover: recovery payload is missing agent.id; bypassing failover for this request`);
            return next();
        }
        markUnavailable(provider);
        const switches = switchesThisTurn(agentId, turn);
        if (switches >= cfg.maxSwitchesPerTurn) {
            ctx.logger.error(`llm-failover: failover switch budget exhausted for this turn (${switches} switches); last failure "${provider}" ${failure.code}`);
            return undefined;
        }
        const target = selectTarget(provider);
        if (target === undefined) {
            ctx.logger.error(`llm-failover: all configured models are currently unavailable (last failure: "${provider}" ${failure.code} after ${count} consecutive failures); failing the request`);
            return undefined;
        }
        // The budget is charged only for a switch that actually happens, so a
        // threshold crossing that stands down costs nothing.
        chargeSwitch(agentId, turn);
        ctx.logger.warn(`llm-failover: provider "${provider}" unavailable after ${count} consecutive ${failure.code} failures; temporarily switching to "${target.provider}" (${target.model})`);
        return { kind: "retry" };
    }
    // Outermost on request build: rewrite unhealthy routes before anything consumes them.
    const disposeRequest = ctx.on("agent/request", async (_payload, next) => {
        let resolved;
        try {
            resolved = await next();
        } catch (error) {
            throw error;
        }
        try {
            return rewriteRoute(resolved);
        } catch (error) {
            try {
                ctx.logger.warn(`llm-failover: internal error while routing; passing the request through unchanged: ${error instanceof Error ? error.message : String(error)}`);
            } catch {}
            return resolved;
        }
    }, { prepend: true });
    function rewriteRoute(resolved) {
        if (!cfg.enabled || lifetime.signal.aborted) return resolved;
        if (!resolved?.provider || !isUnavailable(resolved.provider)) return resolved;
        const target = selectTarget(resolved.provider);
        if (target === undefined) {
            ctx.logger.warn(`llm-failover: primary provider "${resolved.provider}" is marked unavailable and no healthy failover target exists; letting the request proceed toward the terminal error`);
            return resolved;
        }
        ctx.logger.info(`llm-failover: routing request from unavailable "${resolved.provider}" to "${target.provider}" (${target.model})`);
        // Drop the inherited per-model effort: it belongs to the failed route,
        // and the target may reject it outright (UNSUPPORTED_REASONING_EFFORT).
        const { reasoningEffort: _staleEffort, ...withoutStaleEffort } = resolved;
        return {
            ...withoutStaleEffort,
            provider: target.provider,
            model: target.model
        };
    }
    // Success detection: proven assistant output clears that provider's ledger.
    const disposeSessionEvents = ctx.on("session/event", (_session, event) => {
        if (event.type !== "assistant/message") return;
        const source = event.data?.message?.source;
        if (typeof source?.provider === "string" && source.provider !== "") noteSuccess(source.provider);
    });
    // Turn-scoped switch budgets reset when the agent goes idle.
    const disposeStatus = ctx.on("agent/status", ({ agent, status }) => {
        if (status === "idle") turnSwitches.delete(agent.id);
    });
    if (!cfg.enabled) {
        ctx.logger.info('llm-failover: disabled by configuration; original recovery behavior preserved');
    } else if (cfg.models.length === 0) {
        ctx.logger.info('llm-failover: no models pool configured; staying inert until a pool is configured');
    } else {
        const recoverNote = cfg.autoRecover ? "auto-recover" : "manual recovery";
        ctx.logger.info(`llm-failover: active (${cfg.models.length} pool target(s); switch after ${cfg.maxConsecutiveFailures} consecutive failures; cooldown ${cfg.cooldownSeconds}s; ${recoverNote})`);
    }
    ctx.effect(() => async () => {
        disposeError();
        disposeRequest();
        disposeSessionEvents();
        disposeStatus();
        lifetime.abort(new Error("llm-failover plugin disposed"));
    }, "llm-failover: detach listeners");
}
//#endregion
export { Config, DEFAULTS, FAILover_CODE_TOGGLES, apply, inject, isFailoverEligible, name };
