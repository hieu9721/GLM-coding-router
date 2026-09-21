import type { BudgetSnapshot, BudgetWindow, BudgetZone } from "../budget/manager.js";
import { zoneFor } from "../budget/manager.js";
import type { CostEstimate } from "../budget/estimator.js";
import type { RouterConfig } from "../core/config.js";

/**
 * The preflight routing decision (specs/v2-architecture.md Phase E). Pure
 * data: the orchestrator turns `action` into spawns, BudgetWarnings and exit
 * code 41 — this module never does any of that itself.
 */
export interface RouteDecision {
  readonly action: "run" | "downgrade" | "return_to_parent";
  /** The model NAME to actually use — always out of config.models, never "main"/"fast". */
  readonly model: string;
  readonly zone: BudgetZone;
  /** One short human clause, e.g. "zone CONSERVE prefers the fast model". */
  readonly reason: string;
  /** Credits left after the reserve: max(0, binding.remaining − reserve). */
  readonly usableBudget: number;
  /** p90 × safetyFactor of the CHOSEN model, in credits. */
  readonly estimatedCost: number;
  /**
   * The refusal the router WOULD have made. Reported even when not enforced —
   * that report (routingAdvice in every summary.json) is the evidence D3 says
   * the 2.1 flip of refuseOnCritical will be argued from.
   */
  readonly wouldRefuse: boolean;
}

/**
 * DEVIATION FROM THE SPEC, deliberate: the spec's signature says `estimate`
 * (singular), but its own refusal rule needs both models' p90 — wouldRefuse
 * is true only when the cost does not fit for main AND fast (doc §14: always
 * try Flash before giving up). One estimate cannot express that, and deriving
 * the fast estimate by scaling the main one would bake the estimator's
 * baseline ratio (FAST_MODEL_RATIO, 0.4) into the router, so this takes both
 * and the caller computes each with estimateCost.
 *
 * Pure: every input arrives as an argument — no files, no network, no clock,
 * no logging, and the process is never exited from here. The rules, in order:
 *
 * 1. `quotaAware: false` or `confidence: "unknown"` fails OPEN — a monitoring
 *    outage must never block work: action "run", the requested model (or
 *    main), wouldRefuse false, zone as computed.
 * 2. zone = zoneFor(snapshot, config.routing).
 * 3. The BINDING window is whichever of fiveHour/weekly has the lower
 *    remainingRatio — the same window zoneFor's min() picks, so the budget
 *    arithmetic and the zone can never disagree. reserve = reserveRatio ×
 *    binding.limit; usableBudget = max(0, binding.remaining − reserve).
 * 4. Zone preference (doc §12): HEALTHY → main; CONSERVE, HANDOFF_READY and
 *    CRITICAL → fast. CRITICAL is in the fast arm because with the shipped
 *    default it still runs, and a nearly-empty quota should run cheap.
 * 5. `requestedModel` PINS the model, overriding the zone preference. It does
 *    NOT bypass an enforced refusal — only `force` does.
 * 6. wouldRefuse when the zone is CRITICAL, or when NEITHER model's
 *    p90 × safetyFactor fits usableBudget.
 * 7. wouldRefuse becomes `return_to_parent` only when `refuseOnCritical` is
 *    true and `force` is absent.
 * 8. "downgrade" when the fast model was chosen without a pin (the route
 *    changed underneath the caller); otherwise "run".
 *
 * `refuseOnCritical` ships FALSE in 2.0.0 (decision D3), and this function is
 * built to run with it off: the estimator's baseline table has never been
 * measured on this stack, so a wrongly-high row would refuse runs the quota
 * could have afforded, and the user would only find --force after being
 * blocked. With the switch off, wouldRefuse is simply reported and the caller
 * logs a BudgetWarning and runs anyway. Do not flip the default here; flip it
 * in config once the routingAdvice evidence exists.
 *
 * The affordability fallback is one-way (main → fast), mirroring doc §14's
 * "always try Flash before giving up": when the unpinned choice is main and
 * only fast fits, the route downgrades to fast. There is no fast → main
 * upgrade — when a zone below HEALTHY asks for the fast model, the zone (not
 * the estimate) is what protects the remaining quota.
 */
export function decideRoute(input: {
  readonly snapshot: BudgetSnapshot;
  readonly estimates: { readonly main: CostEstimate; readonly fast: CostEstimate };
  readonly config: RouterConfig;
  /** The --model flag; undefined = no pin. */
  readonly requestedModel?: "main" | "fast";
  /** The --force flag: bypasses an ENFORCED refusal (rule 7). */
  readonly force?: boolean;
}): RouteDecision {
  const { snapshot, estimates, config, requestedModel, force } = input;
  const routing = config.routing;

  const zone = zoneFor(snapshot, routing);
  const usableBudget = usableBudgetOf(snapshot, routing.reserveRatio);

  const costOf = (estimate: CostEstimate): number => estimate.p90 * routing.safetyFactor;
  const fits = (estimate: CostEstimate): boolean => costOf(estimate) <= usableBudget;

  // Rule 1 — fail-open. usableBudget/estimatedCost are still reported (an
  // unknown snapshot honestly yields 0: we know no budget), but they gate
  // nothing here.
  if (!routing.quotaAware || snapshot.confidence === "unknown") {
    const slot = requestedModel ?? "main";
    return {
      action: "run",
      model: config.models[slot],
      zone,
      reason: routing.quotaAware ? "quota confidence unknown, failing open" : "quota-aware routing is disabled",
      usableBudget,
      estimatedCost: costOf(estimates[slot]),
      wouldRefuse: false,
    };
  }

  const preferred: "main" | "fast" = zone === "HEALTHY" ? "main" : "fast";
  let slot = requestedModel ?? preferred;
  let fellBackToFit = false;
  if (requestedModel === undefined && slot === "main" && !fits(estimates.main) && fits(estimates.fast)) {
    slot = "fast";
    fellBackToFit = true;
  }

  const wouldRefuse = zone === "CRITICAL" || (!fits(estimates.main) && !fits(estimates.fast));
  // Rule 7 — D3: with the shipped refuseOnCritical: false this stays false and
  // wouldRefuse is only reported. force bypasses the enforced form only.
  const enforced = wouldRefuse && routing.refuseOnCritical && force !== true;

  return {
    action: enforced
      ? "return_to_parent"
      : slot === "fast" && requestedModel === undefined
        ? "downgrade"
        : "run",
    model: config.models[slot],
    zone,
    reason: enforced
      ? zone === "CRITICAL"
        ? "zone CRITICAL, refusal enforced"
        : "neither model's estimated cost fits the usable budget"
      : requestedModel !== undefined
        ? `--model ${requestedModel} pinned`
        : fellBackToFit
          ? "estimated main cost exceeds usable budget, trying the fast model"
          : `zone ${zone} prefers the ${preferred} model`,
    usableBudget,
    estimatedCost: costOf(estimates[slot]),
    wouldRefuse,
  };
}

/**
 * The window the budget arithmetic must respect: the one with the lower
 * remainingRatio, i.e. the same window zoneFor's min() already picked — so
 * the credits and the zone are computed against one window, never two that
 * could disagree. On an exact ratio tie min() is indifferent, so the smaller
 * limit binds: it leaves less absolute headroom, which is the conservative
 * reading. (confidence "unknown" never reaches here with real numbers —
 * decideRoute fails open first — and its zero windows tie harmlessly.)
 */
/**
 * Credits this run may actually spend: the binding window's remaining, less
 * the untouchable reserve, floored at 0.
 *
 * Exported because the Phase F drain controller re-asks the same question
 * every poll, and two implementations of one piece of arithmetic would drift
 * — preflight and mid-run draining have to agree on what "affordable" means
 * or the router contradicts itself halfway through a run.
 */
export function usableBudgetOf(snapshot: BudgetSnapshot, reserveRatio: number): number {
  const binding = bindingWindow(snapshot);
  return Math.max(0, binding.remaining - reserveRatio * binding.limit);
}

function bindingWindow(snapshot: BudgetSnapshot): BudgetWindow {
  const { fiveHour, weekly } = snapshot;
  if (fiveHour.remainingRatio !== weekly.remainingRatio) {
    return fiveHour.remainingRatio < weekly.remainingRatio ? fiveHour : weekly;
  }
  return fiveHour.limit <= weekly.limit ? fiveHour : weekly;
}
