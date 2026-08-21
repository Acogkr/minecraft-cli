import { MinecraftCliError } from "./errors";

export interface JsonChange {
  path: string;
  before?: unknown;
  after?: unknown;
  kind: "added" | "removed" | "changed";
}

export interface JsonAssertion {
  path?: string;
  selector?: string;
  equals?: unknown;
  notEquals?: unknown;
  contains?: unknown;
  matches?: string;
  exists?: boolean;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

const SECRET_KEY = /(?:^|_)(?:token|secret|password|authorization|cookie|credential|refresh|access|device_code)(?:$|_)/i;

export function selectJson(value: unknown, selector: string) {
  const input = selector.trim();
  if (!input || input === "$" || input === ".") return value;
  const normalized = input.startsWith("$") ? input.slice(1) : input;
  const tokens: Array<string | number> = [];
  const pattern = /(?:^|\.)([^.\[\]]+)|\[(?:(\d+)|["']([^"']+)["'])\]/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = pattern.exec(normalized)) !== null) {
    if (match.index !== consumed) throw new MinecraftCliError("JSON_SELECTOR_INVALID", `Unsupported JSON selector '${selector}'.`, 400);
    tokens.push(match[1] ?? match[3] ?? Number(match[2]));
    consumed = pattern.lastIndex;
  }
  if (consumed !== normalized.length || tokens.length === 0) {
    throw new MinecraftCliError("JSON_SELECTOR_INVALID", `Unsupported JSON selector '${selector}'.`, 400);
  }
  let current: any = value;
  for (const token of tokens) {
    if (current === null || current === undefined || !(token in Object(current))) return undefined;
    current = current[token as any];
  }
  return current;
}

export function interpolateString(input: string, variables: Record<string, unknown>) {
  const exact = input.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_.-]*)\}$/);
  if (exact) return stringifyVariable(resolveVariable(variables, exact[1]));
  return input.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_.-]*)\}/g, (_match, name) => stringifyVariable(resolveVariable(variables, name)));
}

function resolveVariable(variables: Record<string, unknown>, name: string) {
  const [root, ...rest] = name.split(".");
  if (!(root in variables)) throw new MinecraftCliError("SCENARIO_VARIABLE_MISSING", `Scenario variable '${root}' is not defined.`, 400);
  return rest.length === 0 ? variables[root] : selectJson(variables[root], rest.join("."));
}

function stringifyVariable(value: unknown) {
  if (value === undefined) throw new MinecraftCliError("SCENARIO_VARIABLE_MISSING", "Scenario variable selector returned no value.", 400);
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function evaluateAssertions(response: unknown, assertions: JsonAssertion[]) {
  const failures: Array<Record<string, unknown>> = [];
  for (let index = 0; index < assertions.length; index++) {
    const assertion = assertions[index];
    const selector = assertion.path ?? assertion.selector ?? "$";
    const actual = selectJson(response, selector);
    const checks = Object.entries(assertion).filter(([key]) => !["path", "selector"].includes(key));
    if (checks.length !== 1) throw new MinecraftCliError("SCENARIO_ASSERTION_INVALID", `Assertion ${index + 1} must contain exactly one operator.`, 400);
    const [operator, expected] = checks[0];
    let passed = false;
    switch (operator) {
      case "equals": passed = deepEqual(actual, expected); break;
      case "notEquals": passed = !deepEqual(actual, expected); break;
      case "contains": passed = containsValue(actual, expected); break;
      case "matches": passed = typeof actual === "string" && new RegExp(String(expected)).test(actual); break;
      case "exists": passed = Boolean(expected) ? actual !== undefined : actual === undefined; break;
      case "gt": passed = typeof actual === "number" && actual > Number(expected); break;
      case "gte": passed = typeof actual === "number" && actual >= Number(expected); break;
      case "lt": passed = typeof actual === "number" && actual < Number(expected); break;
      case "lte": passed = typeof actual === "number" && actual <= Number(expected); break;
      default: throw new MinecraftCliError("SCENARIO_ASSERTION_INVALID", `Unsupported assertion operator '${operator}'.`, 400);
    }
    if (!passed) failures.push({ index: index + 1, selector, operator, expected: redactSecrets(expected), actual: redactSecrets(actual) });
  }
  return failures;
}

function containsValue(actual: unknown, expected: unknown) {
  if (typeof actual === "string") return actual.includes(String(expected));
  if (Array.isArray(actual)) return actual.some(value => deepEqual(value, expected));
  if (actual && typeof actual === "object" && typeof expected === "string") return expected in actual;
  return false;
}

export function diffJson(before: unknown, after: unknown, limit = 200) {
  const changes: JsonChange[] = [];
  walkDiff(before, after, "$", changes, limit);
  return { changed: changes.length > 0, changeCount: changes.length, truncated: changes.length >= limit, changes };
}

function walkDiff(before: any, after: any, currentPath: string, changes: JsonChange[], limit: number) {
  if (changes.length >= limit || deepEqual(before, after)) return;
  if (!isContainer(before) || !isContainer(after) || Array.isArray(before) !== Array.isArray(after)) {
    changes.push({ path: currentPath, kind: before === undefined ? "added" : after === undefined ? "removed" : "changed", before: redactSecrets(before), after: redactSecrets(after) });
    return;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort((a, b) => numericAwareCompare(a, b))) {
    if (changes.length >= limit) return;
    const childPath = Array.isArray(after) || Array.isArray(before) ? `${currentPath}[${key}]` : `${currentPath}.${key}`;
    if (!(key in before)) changes.push({ path: childPath, kind: "added", after: redactSecrets(after[key]) });
    else if (!(key in after)) changes.push({ path: childPath, kind: "removed", before: redactSecrets(before[key]) });
    else walkDiff(before[key], after[key], childPath, changes, limit);
  }
}

function numericAwareCompare(left: string, right: string) {
  const a = Number(left);
  const b = Number(right);
  return Number.isInteger(a) && Number.isInteger(b) ? a - b : left.localeCompare(right);
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

export function deepEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return value.replace(/(?:Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]");
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map(entry => redactSecrets(entry, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SECRET_KEY.test(key) ? "[redacted]" : redactSecrets(entry, seen)]));
}
