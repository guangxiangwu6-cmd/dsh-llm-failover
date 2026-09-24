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
//#region wall detection (deterministic-until-reset failures)
/**
* A "wall" is a failure that will keep failing until a reset: an exhausted
* quota, a metered usage window, a billing hard limit. Unlike a blip it is not
* worth retrying at the same provider, so a wall switches on the FIRST failure
* and parks the provider until the reset the provider itself published.
*
* Two sources are trusted, in order:
*
* 1. `failure.providerRetryAfterMs` — the harness already parsed the provider's
*    Retry-After for us (dsh-llm-retry consumes the same field). It is the only
*    structured signal available at this seam.
* 2. The failure message — Command Code's refusals arrive as prose
*    ("usage limit for your plan has been reached", "premium credits
*    exhausted", plus a "resets at <ISO>" stamp). The same marker list lives in
*    the Command Code account-rotation implementation, which established that
*    only a message that NAMES a window may be read as one.
*
* Everything else keeps the threshold behavior, so a two-second burst throttle
* is still absorbed by retries instead of yanking the provider out of the pool.
*/
const WALL_CODES = new Set(["QUOTA"]);
/** A published reset at least this far out is a wall; anything shorter is a blip worth retrying. */
const WALL_MIN_RESET_MS = 60 * 1000;
/** Reset hints beyond this are not believed (a bogus far-future stamp must not park a provider forever). */
const MAX_TRUSTED_RESET_MS = 30 * 24 * 60 * 60 * 1000;
/**
* Prose markers of account-level exhaustion, used only as a FALLBACK for
* deployments where the failure did not arrive as the harness's own QUOTA code
* (the harness classifies "insufficient credits", "usage limit … reached" and
* friends via `isQuotaExceededError`, so in practice the code path usually
* fires first).
*
* Ambiguous wording is deliberately NOT listed — "quota exceeded" alone can be
* a per-minute meter as easily as a monthly allowance, so it only counts as a
* wall when the provider also published a reset (the branch above). The
* account-level phrasings below are unambiguous, and the first one is Command
* Code's exact refusal wording.
*/
const WALL_MESSAGE_MARKERS = [
    "usage limit for your plan",
    "premium credits exhausted",
    "insufficient credits",
    "insufficient balance",
    "insufficient quota",
    "credit balance is too low",
    "billing hard limit",
    "out of credits"
];
/** "…resets at 2026-09-25T03:38:40Z" (Command Code's published reset stamp). */
const RESET_STAMP_PATTERN = /resets? at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i;
/** "…retry again in 30 seconds" / "in 2 minutes" / "in 1 hour". */
const RESET_PROSE_PATTERN = /(?:retry|try)\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\b/i;
const PROSE_UNIT_MS = {
    ms: 1,
    s: 1000, sec: 1000, secs: 1000, seconds: 1000,
    m: 60_000, min: 60_000, mins: 60_000, minutes: 60_000,
    h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hours: 3_600_000
};
/**
* @param failure - the LlmFailure the harness reported.
* @param nowMs - current time (injected so tests can drive a fake clock).
* @returns `{ wall, parkMs?, source }`; `parkMs` is set only when the provider
*          itself published a usable reset — otherwise `undefined` means "use
*          the class default".
*/
function resolveResetPlan(failure, nowMs) {
    const message = typeof failure?.message === "string" ? failure.message : "";
    const lower = message.toLowerCase();
    const code = typeof failure?.code === "string" ? failure.code : "";
    const published = failure?.providerRetryAfterMs;
    const publishedMs = typeof published === "number" && Number.isFinite(published) && published > 0 ? published : undefined;
    let stampedMs;
    const stamp = message.match(RESET_STAMP_PATTERN)?.[1];
    if (stamp !== undefined) {
        const parsed = Date.parse(stamp);
        if (!Number.isNaN(parsed)) stampedMs = parsed - nowMs;
    }
    let proseMs;
    const prose = message.match(RESET_PROSE_PATTERN);
    if (prose !== null) proseMs = Number(prose[1]) * (PROSE_UNIT_MS[prose[2].toLowerCase()] ?? 0);
    const rawReset = publishedMs ?? stampedMs ?? proseMs;
    const resetMs = rawReset !== undefined && Number.isFinite(rawReset) && rawReset > 0 && rawReset <= MAX_TRUSTED_RESET_MS ? rawReset : undefined;
    const namedWindow = WALL_MESSAGE_MARKERS.some((marker) => lower.includes(marker));
    if (resetMs !== undefined && resetMs >= WALL_MIN_RESET_MS) {
        return { wall: true, parkMs: resetMs, source: publishedMs !== undefined ? "provider-retry-after" : (stampedMs !== undefined ? "reset-stamp" : "retry-after-prose") };
    }
    if (WALL_CODES.has(code)) return { wall: true, source: "quota-code" };
    if (namedWindow) return { wall: true, source: "message-marker" };
    return { wall: false, parkMs: resetMs, source: resetMs !== undefined ? "short-reset" : "transient" };
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
* 1. Failover-eligible failures are split in two by {@link resolveResetPlan}:
*
*    - a WALL (exhausted quota, a metered usage window, a published reset at
*      least a minute out) is a fact, not a blip: it switches on the FIRST
*      failure and parks the provider until the reset the provider published —
*      4h by default when it published none.
*    - everything else (5xx, timeouts, transport, stream interruption, a
*      two-second burst throttle) keeps the consecutive-failure counter.
*      Below `maxConsecutiveFailures` the downstream stack keeps ownership
*      (typically llm-retry's bounded backoff), so existing same-provider retry
*      behavior is unchanged; at the threshold this plugin takes over.
*
* 2. A parked provider sits out for its cooldown, which escalates with every
*    consecutive park (doubling, capped by `maxCooldownSeconds`) unless the
*    provider itself published the reset — information is used verbatim, only
*    penalties grow.
* 3. When a cooldown elapses the provider is NOT handed back as healthy: it is
*    admitted as a HALF-OPEN probe. The request that goes through decides —
*    proven output clears its ledger (penalties included) and an assistant
*    message recovers it actively; a failure re-parks it immediately without
*    re-earning the threshold.
* 4. While a provider is parked, every request build resolves through the
*    `agent/request` listener, which rewrites the route to the best healthy
*    pool entry (closed providers first, half-open ones only as a last resort).
*    Later steps of the same turn continue seamlessly on the replacement model;
*    context, tool state, and task progress live in the durable session and
*    never depend on which provider serves a step.
* 5. When no healthy target remains (or the per-turn switch cap is hit) the
*    listener stands down: the original LlmError surfaces ("all models
*    unavailable") instead of an infinite switch loop. The host log then names
*    the earliest recovery and dumps every provider's state, because the error
*    text itself cannot be rewritten from this seam (RequestErrorAction is only
*    `{ kind: 'retry' } | undefined`).
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
    // A wall (exhausted quota / metered usage window) has no published reset to
    // trust, so it parks for hours rather than a minute; each failed probe
    // doubles that until `maxCooldownSeconds`.
    quotaCooldownSeconds: 4 * 60 * 60,
    maxCooldownSeconds: 24 * 60 * 60,
    autoRecover: true,
    maxSwitchesPerTurn: 8,
    failoverOnRateLimit: true,
    failoverOnTimeout: true,
    failoverOnServerError: true,
    failoverOnTransportError: true,
    failoverOnStreamInterrupted: true,
    failoverOnEmptyResponse: false,
    // Was false: a provider whose account is out of quota kept being retried on
    // every request. A wall is a fact, not a blip (see resolveResetPlan).
    failoverOnQuota: true
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
/** Seconds-valued fields that must be strictly positive (a zero-length cooldown oscillates). */
const POSITIVE_SECONDS_FIELDS = new Set(["cooldownSeconds", "quotaCooldownSeconds", "maxCooldownSeconds"]);
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
        if (POSITIVE_SECONDS_FIELDS.has(key)) {
            // Strictly positive: a zero-length cooldown expires in the same
            // instant it is set, which oscillates routing between the failed
            // provider and its replacement instead of holding a cooldown.
            if (typeof value === "number" && Number.isFinite(value) && value > 0) cfg[key] = value;
            else problems.push(`"${key}" must be a number > 0; using the default`);
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
        .replace(/((?:api[-_]?key|access[-_]?token|token|key)=)[^&\s]+/gi, "$1***")
        // Header-shaped credentials ("x-api-key: sk-...") are colon-delimited
        // rather than query-parameter shaped, so they need their own pass.
        .replace(/((?:x-)?api[-_]?key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1***");
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
    /** provider -> time of the most recent reroute away from it (see {@link noteReroute}). */
    const reroutedAt = new Map();
    function providerState(provider) {
        let state = health.get(provider);
        if (state === undefined) {
            state = {
                failures: 0,
                unavailableUntil: undefined,
                announcedDown: false,
                /** Cooldown elapsed, waiting for one probe request to prove itself (see isUnavailable). */
                halfOpen: false,
                /** Consecutive parks without a proven success; drives the escalating cooldown. */
                parks: 0,
                /** "wall" | "failures" — why it is parked, for the logs. */
                lastCause: undefined
            };
            health.set(provider, state);
        }
        return state;
    }
    /** Human-readable duration for logs ("45s", "12m", "3h20m"). */
    function formatDuration(ms) {
        const seconds = Math.max(0, Math.round(ms / 1000));
        if (seconds < 90) return `${seconds}s`;
        const minutes = Math.round(seconds / 60);
        if (minutes < 90) return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
    }
    /**
    * Health check with lazy cooldown expiry.
    *
    * An elapsed deadline does NOT hand the provider back as healthy (the old
    * behavior): it is admitted as a HALF-OPEN probe instead, and the one
    * request that goes through decides. A failed probe re-parks it immediately
    * with an escalated cooldown, so a flapping provider can neither be retried
    * for free on every cooldown nor sit out forever:
    *
    * - success (an assistant message proves output) -> ledger dropped, healthy
    * - failure -> parked again, wait doubled (capped by maxCooldownSeconds)
    *
    * This is opossum's half-open state adapted to an observer: we watch
    * failures instead of proxying calls, so the "one probe at a time" cap is
    * not enforceable here — the escalation bounds the damage instead.
    */
    function isUnavailable(provider) {
        const state = health.get(provider);
        if (state?.unavailableUntil === undefined) return false;
        if (now() >= state.unavailableUntil) {
            state.unavailableUntil = undefined;
            state.halfOpen = true;
            state.failures = 0;
            if (cfg.autoRecover) ctx.logger.info(`llm-failover: provider "${provider}" cooldown elapsed; admitting it back as a probe (${state.parks} park(s) so far, so the next failure parks it for ${formatDuration(escalatedParkMs(state))})`);
            return false;
        }
        return true;
    }
    function isHalfOpen(provider) {
        return health.get(provider)?.halfOpen === true;
    }
    /** The escalating wait for the next park of an already-parked provider. */
    function escalatedParkMs(state) {
        const base = state.lastCause === "wall" ? cfg.quotaCooldownSeconds * 1000 : cfg.cooldownSeconds * 1000;
        const escalated = base * 2 ** Math.max(0, state.parks);
        return Math.min(escalated, cfg.maxCooldownSeconds * 1000);
    }
    /**
    * Park `provider`. A reset the provider itself published is used verbatim —
    * that is information, not a penalty — while everything else escalates with
    * each consecutive park. Returns the applied cooldown in ms.
    */
    function markUnavailable(provider, cause, parkMs) {
        const state = providerState(provider);
        state.failures = 0;
        state.halfOpen = false;
        state.parks += 1;
        state.lastCause = cause;
        const ms = parkMs !== undefined
            ? Math.min(parkMs, cfg.maxCooldownSeconds * 1000)
            : escalatedParkMs({ ...state, parks: state.parks - 1 });
        state.unavailableUntil = cfg.autoRecover && ms > 0 ? now() + ms : Number.POSITIVE_INFINITY;
        state.announcedDown = true;
        return ms;
    }
    /** The pool provider that will come back soonest, for the terminal log line. */
    function earliestRecovery() {
        let best;
        for (const [provider, state] of health) {
            if (state.unavailableUntil === undefined || !Number.isFinite(state.unavailableUntil)) continue;
            if (best === undefined || state.unavailableUntil < best.at) best = { provider, at: state.unavailableUntil };
        }
        return best;
    }
    /** One-line dump of every provider with non-healthy state (terminal log line). */
    function describeHealth() {
        if (health.size === 0) return "every configured provider is healthy";
        const parts = [];
        for (const [provider, state] of health) {
            if (state.unavailableUntil !== undefined && Number.isFinite(state.unavailableUntil)) {
                parts.push(`${provider}=parked(${formatDuration(state.unavailableUntil - now())}, ${state.lastCause ?? "?"})`);
            } else if (state.halfOpen) {
                parts.push(`${provider}=half-open(probing)`);
            } else if (state.failures > 0) {
                parts.push(`${provider}=failing(${state.failures})`);
            }
        }
        return parts.length > 0 ? parts.join(", ") : "every configured provider is healthy";
    }
    /**
    * Record that a request was rerouted away from `provider` just now.
    *
    * This exists as a trust filter for {@link noteSuccess}. After a reroute the
    * harness may still attribute the resulting assistant message to the route
    * the request was BUILT for rather than the replacement that actually served
    * it, and an ambiguous attribution must not cancel a cooldown the provider
    * has not genuinely earned back.
    */
    function noteReroute(provider) {
        const at = now();
        // Sweep entries that have aged out of the cooldown window so the map
        // stays bounded by the number of providers rerouted within one window.
        const horizon = at - cfg.cooldownSeconds * 1000;
        for (const [key, stamp] of reroutedAt) {
            if (stamp < horizon) reroutedAt.delete(key);
        }
        reroutedAt.set(provider, at);
    }
    function noteSuccess(provider) {
        const state = health.get(provider);
        if (state === undefined) return;
        // Cooldown guard: while the provider is still cooling down, a success
        // report is only conclusive if we never rerouted a request away from it
        // inside this window. Otherwise the message may belong to the model we
        // switched to, and trusting it would bounce the next request straight
        // back onto a provider that is still failing.
        if (state.unavailableUntil !== undefined && now() < state.unavailableUntil) {
            const rerouted = reroutedAt.get(provider);
            if (rerouted !== undefined && now() - rerouted < cfg.cooldownSeconds * 1000) {
                const ageSeconds = Math.round((now() - rerouted) / 1000);
                ctx.logger.info(`llm-failover: ignoring a success attributed to "${provider}" while it is cooling down; a request was rerouted away from it ${ageSeconds}s ago, so the attribution is ambiguous and the cooldown stands`);
                return;
            }
        }
        const wasProbing = state.halfOpen === true;
        const wasDegraded = wasProbing || state.unavailableUntil !== undefined || state.announcedDown || state.failures > 0;
        // See isUnavailable: fully recovered providers leave no ledger entry.
        // Dropping it also forfeits the escalation penalty (parks), which is the
        // point: a proven provider starts over with a clean slate.
        health.delete(provider);
        if (wasProbing) ctx.logger.info(`llm-failover: provider "${provider}" probe succeeded after ${state.parks} park(s); back in the pool with a clean slate`);
        else if (wasDegraded) ctx.logger.info(`llm-failover: provider "${provider}" recovered and rejoined the model pool`);
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
    /**
    * The next healthy target: pool order, minus the failing provider and minus
    * anything still parked. Providers that are merely half-open (cooldown
    * elapsed, awaiting their probe) are held back while any closed provider is
    * available, so a not-yet-proven provider cannot preempt a healthy one —
    * they are only reached when nothing else is left.
    */
    function selectTarget(failedProvider) {
        const candidates = [];
        for (const route of pool()) {
            if (route.provider === failedProvider) continue;
            if (isUnavailable(route.provider)) continue;
            candidates.push(route);
        }
        const closed = candidates.filter((route) => !isHalfOpen(route.provider));
        return (closed.length > 0 ? closed : candidates)[0];
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
        // The downstream recovery stack must be invoked at most once. If
        // decideRecovery already handed the failure to it and then threw, calling
        // it again here would replay a recovery behind the caller's back.
        let downstreamCalled = false;
        const nextOnce = () => {
            downstreamCalled = true;
            return next();
        };
        try {
            return await decideRecovery(payload, nextOnce);
        } catch (error) {
            try {
                ctx.logger.warn(`llm-failover: internal error during recovery decision; bypassing failover for this request: ${error instanceof Error ? error.message : String(error)}`);
            } catch {}
            return downstreamCalled ? undefined : next();
        }
    }, { prepend: true });
    async function decideRecovery(payload, next) {
        const { agent, turn, provider, failure } = payload;
        if (!cfg.enabled || lifetime.signal.aborted) return next();
        if (cfg.models.length === 0) return next();
        if (!isFailoverEligible(failure.code, cfg)) return next();
        const state = providerState(provider);
        // Is this attempt the probe promised when the cooldown elapsed? Then it
        // decides: success clears the ledger, failure re-parks immediately —
        // there is no threshold left to earn.
        const probing = state.halfOpen === true;
        const plan = resolveResetPlan(failure, now());
        let count = state.failures;
        if (!probing) {
            state.failures += 1;
            count = state.failures;
        }
        const verdict = probing ? "probe failed" : `consecutive failure ${count}/${cfg.maxConsecutiveFailures}`;
        const reason = plan.wall ? `, a wall (${plan.source})` : "";
        ctx.logger.warn(`llm-failover: provider "${provider}" request failed (${failure.code}${reason}): ${verdict}: ${brief(failure.message)}`);
        if (!probing && !plan.wall && count < cfg.maxConsecutiveFailures) {
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
        // Take over: a wall (first occurrence), a failed probe, or the threshold.
        const agentId = agent?.id;
        if (agentId === undefined || agentId === null) {
            // Bail out BEFORE marking the provider unavailable: a bypassed
            // decision must never pull a provider out of the pool without a
            // switch decision to go with it. The consecutive-failure counter
            // incremented above is deliberately kept — this attempt did fail.
            ctx.logger.warn(`llm-failover: recovery payload is missing agent.id; bypassing failover for this request`);
            return next();
        }
        const parkedMs = markUnavailable(provider, plan.wall ? "wall" : "failures", plan.wall ? plan.parkMs : undefined);
        const parkedFor = plan.parkMs !== undefined ? `${formatDuration(parkedMs)} (the provider's own reset)` : formatDuration(parkedMs);
        const switches = switchesThisTurn(agentId, turn);
        if (switches >= cfg.maxSwitchesPerTurn) {
            ctx.logger.error(`llm-failover: failover switch budget exhausted for this turn (${switches} switches); last failure "${provider}" ${failure.code}`);
            return undefined;
        }
        const target = selectTarget(provider);
        if (target === undefined) {
            const earliest = earliestRecovery();
            ctx.logger.error(`llm-failover: no healthy target left (last failure: "${provider}" ${failure.code}${probing ? " on its probe" : ` after ${count} consecutive failures`}); failing this request.`
                + (earliest === undefined ? "" : ` Earliest recovery: "${earliest.provider}" in ${formatDuration(earliest.at - now())}${cfg.autoRecover ? " (it is admitted as a probe then)" : " (autoRecover is off, so only a restart clears it)"}`));
            ctx.logger.error(`llm-failover: provider states: ${describeHealth()}`);
            return undefined;
        }
        // The budget is charged only for a switch that actually happens, so a
        // threshold crossing that stands down costs nothing.
        chargeSwitch(agentId, turn);
        ctx.logger.warn(`llm-failover: provider "${provider}" parked for ${parkedFor}${probing ? " after a failed probe" : plan.wall ? ` (${plan.source})` : ` after ${count} consecutive ${failure.code} failures`}; temporarily switching to "${target.provider}" (${target.model})`);
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
        noteReroute(resolved.provider);
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
        const recoverNote = cfg.autoRecover ? "auto-recover via half-open probes" : "manual recovery";
        const distinctProviders = new Set(pool().map((route) => route.provider)).size;
        ctx.logger.info(`llm-failover: active (${cfg.models.length} pool entry/entries covering ${distinctProviders} provider(s); switch after ${cfg.maxConsecutiveFailures} consecutive failures, or on the first quota/usage wall; cooldowns ${cfg.cooldownSeconds}s (blip) / ${cfg.quotaCooldownSeconds}s (wall), doubling per consecutive park, capped at ${cfg.maxCooldownSeconds}s; ${recoverNote})`);
        if (cfg.models.length > distinctProviders) {
            const dead = cfg.models.length - distinctProviders;
            ctx.logger.warn(`llm-failover: ${dead} pool entry/entries repeat a provider that is already listed earlier; a target is selected per provider, so only the first entry of each provider can ever be chosen — the remaining ${dead} entry/entries are inert`);
        }
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
export { Config, DEFAULTS, FAILover_CODE_TOGGLES, apply, inject, isFailoverEligible, name, resolveResetPlan };
