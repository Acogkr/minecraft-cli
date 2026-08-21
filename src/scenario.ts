import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MinecraftCliError } from "./errors";
import { evaluateAssertions, interpolateString, redactSecrets, selectJson, type JsonAssertion } from "./json-utils";

type StepCondition = "success" | "failure" | "always";

interface ScenarioStep {
  name?: string;
  args: string[];
  timeoutMs?: number;
  when?: StepCondition;
  allowFailure?: boolean;
  includeResponse?: boolean;
}

interface ScenarioDefinition {
  version?: number;
  name?: string;
  timeoutMs?: number;
  variables?: Record<string, unknown>;
  steps: any[];
}

interface ScenarioOptions {
  file: string;
  workspace: string;
  cliFile: string;
  full?: boolean;
  dryRun?: boolean;
}

const ALLOWED_ROOT_COMMANDS = new Set(["status", "session", "visual", "actor", "probe", "cleanup"]);
const MAX_STEPS = 500;
const MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export async function executeScenario(options: ScenarioOptions) {
  const definition = readScenario(options.file);
  if (definition.version === 2) return executeScenarioV2(options, definition);
  return executeScenarioV1(options);
}

function executeScenarioV1(options: ScenarioOptions) {
  const definition = readScenario(options.file);
  const scenarioName = safeFilePart(definition.name ?? path.basename(options.file, path.extname(options.file)));
  const steps = definition.steps.map((step, index) => validateStep(step, index, definition.timeoutMs));

  if (options.dryRun) {
    return {
      ok: true,
      data: {
        dryRun: true,
        name: scenarioName,
        stepCount: steps.length,
        steps: steps.map((step, index) => ({ index: index + 1, name: step.name, action: actionName(step.args), when: step.when }))
      }
    };
  }

  const startedAt = new Date();
  const results: any[] = [];
  let runFailed = false;

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const shouldRun = step.when === "always" || (step.when === "failure" ? runFailed : !runFailed);
    if (!shouldRun) {
      results.push({ index: index + 1, name: step.name, action: actionName(step.args), when: step.when, skipped: true });
      continue;
    }

    const stepStarted = Date.now();
    const child = spawnSync(process.execPath, [
      options.cliFile,
      "--json",
      "--compact",
      "--workspace",
      options.workspace,
      ...step.args
    ], {
      cwd: options.workspace,
      encoding: "utf8",
      timeout: step.timeoutMs,
      windowsHide: true,
      maxBuffer: MAX_BUFFER_BYTES
    });

    const response = parseResponse(child.stdout, child.stderr, child.error);
    const passed = child.status === 0 && response?.ok === true;
    const allowedFailure = !passed && step.allowFailure;
    if (!passed && !allowedFailure) runFailed = true;
    results.push({
      index: index + 1,
      name: step.name,
      action: actionName(step.args),
      when: step.when,
      ok: passed,
      ...(allowedFailure ? { allowedFailure: true } : {}),
      exitCode: child.status,
      durationMs: Date.now() - stepStarted,
      response
    });
  }

  const finishedAt = new Date();
  const report = {
    version: 1,
    name: scenarioName,
    source: path.resolve(options.file),
    workspace: options.workspace,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ok: !runFailed,
    steps: results
  };
  const runsDir = path.join(options.workspace, ".minecraft-cli", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const reportFile = path.join(runsDir, `${timestampFilePart()}-${scenarioName}.json`);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const summarySteps = results.map((result) => ({
    index: result.index,
    name: result.name,
    action: result.action,
    ...(result.skipped ? { skipped: true } : {
      ok: result.ok,
      ...(result.allowedFailure ? { allowedFailure: true } : {}),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(!result.ok || steps[result.index - 1].includeResponse ? { response: result.response } : {})
    })
  }));
  const executed = results.filter(result => !result.skipped);
  const summary = {
    ok: !runFailed,
    data: {
      name: scenarioName,
      durationMs: report.durationMs,
      passed: executed.filter(result => result.ok).length,
      failed: executed.filter(result => !result.ok && !result.allowedFailure).length,
      allowedFailures: executed.filter(result => result.allowedFailure).length,
      skipped: results.filter(result => result.skipped).length,
      reportFile,
      steps: summarySteps
    }
  };
  const fullResponse = { ok: !runFailed, data: { ...report, reportFile } };
  const fullBytes = Buffer.byteLength(JSON.stringify(fullResponse));
  (summary.data as any).output = { summaryBytes: 0, fullBytes, savedBytes: 0, reductionPercent: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    const summaryBytes = Buffer.byteLength(JSON.stringify(summary));
    (summary.data as any).output = {
      summaryBytes,
      fullBytes,
      savedBytes: Math.max(0, fullBytes - summaryBytes),
      reductionPercent: fullBytes === 0 ? 0 : Number(((1 - summaryBytes / fullBytes) * 100).toFixed(1))
    };
  }
  return options.full ? fullResponse : summary;
}

interface V2CaptureSpec {
  selector: string;
}

interface V2ActionStep extends ScenarioStep {
  capture?: Record<string, string | V2CaptureSpec>;
  assertions?: JsonAssertion[];
  assert?: JsonAssertion[];
  retry?: number;
  retryDelayMs?: number;
  repeat?: number;
}

type ValidV2Action = Required<Pick<V2ActionStep, "name" | "args" | "timeoutMs" | "when">> & V2ActionStep;

interface V2ParallelStep {
  name: string;
  parallel: ValidV2Action[];
  when: StepCondition;
  allowFailure?: boolean;
}

type V2Step = ValidV2Action | V2ParallelStep;

async function executeScenarioV2(options: ScenarioOptions, definition: ScenarioDefinition) {
  const scenarioName = safeFilePart(definition.name ?? path.basename(options.file, path.extname(options.file)));
  const steps = definition.steps.map((step, index) => validateV2Step(step, index, definition.timeoutMs));
  if (options.dryRun) {
    return {
      ok: true,
      data: {
        version: 2,
        dryRun: true,
        name: scenarioName,
        stepCount: steps.reduce((count, step) => count + ("parallel" in step ? step.parallel.length : 1), 0),
        steps: steps.map((step, index) => "parallel" in step
          ? { index: index + 1, name: step.name, parallel: step.parallel.map(child => ({ name: child.name, action: actionName(child.args) })), when: step.when }
          : { index: index + 1, name: step.name, action: actionName(step.args), when: step.when, retry: step.retry, repeat: step.repeat })
      }
    };
  }

  const startedAt = new Date();
  const variables: Record<string, unknown> = { ...(definition.variables ?? {}) };
  const results: any[] = [];
  let runFailed = false;

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const shouldRun = step.when === "always" || (step.when === "failure" ? runFailed : !runFailed);
    if (!shouldRun) {
      results.push({ index: index + 1, name: step.name, skipped: true, ...( "parallel" in step ? { action: "parallel" } : { action: actionName(step.args) }) });
      continue;
    }

    if ("parallel" in step) {
      const variableSnapshot = { ...variables };
      const groupStarted = Date.now();
      const children = await Promise.all(step.parallel.map(child => executeV2Action(options, child, variableSnapshot)));
      const captureOwners = new Map<string, string>();
      for (const child of children) {
        for (const [key, value] of Object.entries(child.captures ?? {})) {
          const owner = captureOwners.get(key);
          if (owner) {
            child.ok = false;
            child.assertionFailures = [...(child.assertionFailures ?? []), { code: "SCENARIO_CAPTURE_CONFLICT", variable: key, owners: [owner, child.name] }];
          } else {
            captureOwners.set(key, child.name);
            variables[key] = value;
          }
        }
      }
      const passed = children.every(child => child.ok || child.allowedFailure);
      const allowedFailure = !passed && step.allowFailure;
      if (!passed && !allowedFailure) runFailed = true;
      results.push({ index: index + 1, name: step.name, action: "parallel", ok: passed, ...(allowedFailure ? { allowedFailure: true } : {}), durationMs: Date.now() - groupStarted, children });
      continue;
    }

    const result = await executeV2Action(options, step, variables);
    if (!result.ok && !result.allowedFailure) runFailed = true;
    Object.assign(variables, result.captures ?? {});
    results.push({ index: index + 1, ...result });
  }

  const finishedAt = new Date();
  const executedActions = flattenV2Results(results).filter(result => !result.skipped);
  const report = redactSecrets({
    version: 2,
    name: scenarioName,
    source: path.resolve(options.file),
    workspace: options.workspace,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ok: !runFailed,
    steps: results
  }) as any;
  const runsDir = path.join(options.workspace, ".minecraft-cli", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const reportFile = path.join(runsDir, `${timestampFilePart()}-${scenarioName}.json`);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (options.full) return { ok: !runFailed, data: { ...report, reportFile } };
  const failed = executedActions.filter(result => !result.ok && !result.allowedFailure);
  const summary: any = {
    ok: !runFailed,
    data: {
      name: scenarioName,
      passed: executedActions.filter(result => result.ok).length,
      durationMs: report.durationMs,
      reportFile
    }
  };
  if (failed.length > 0) {
    summary.data.failed = failed.length;
    summary.data.failures = failed.map(result => ({
      name: result.name,
      action: result.action,
      exitCode: result.exitCode,
      attempts: result.attempts,
      assertions: result.assertionFailures,
      capsuleFile: result.capsuleFile,
      response: redactSecrets(result.response)
    }));
  }
  return summary;
}

function validateV2Step(step: any, index: number, defaultTimeout?: number): V2Step {
  if (!step || typeof step !== "object" || Array.isArray(step)) throw new MinecraftCliError("SCENARIO_STEP_INVALID", `Step ${index + 1} must be an object.`, 400);
  const when = validateWhen(step.when, index);
  if (Array.isArray(step.parallel)) {
    if (step.parallel.length < 2 || step.parallel.length > 8) throw new MinecraftCliError("SCENARIO_PARALLEL_INVALID", `Parallel step ${index + 1} must contain 2 to 8 actions.`, 400);
    const children = step.parallel.map((child: any, childIndex: number) => validateV2Action(child, index, defaultTimeout, `${index + 1}.${childIndex + 1}`));
    const captureKeys = children.flatMap(child => Object.keys(child.capture ?? {}));
    if (new Set(captureKeys).size !== captureKeys.length) throw new MinecraftCliError("SCENARIO_CAPTURE_CONFLICT", `Parallel step ${index + 1} contains duplicate capture variables.`, 400);
    return { name: validateName(step.name, `parallel-${index + 1}`), parallel: children, when, allowFailure: validateBoolean(step.allowFailure, `Step ${index + 1} allowFailure`) };
  }
  return validateV2Action(step, index, defaultTimeout, String(index + 1));
}

function validateV2Action(step: any, index: number, defaultTimeout: number | undefined, label: string) {
  const base = validateStep(step, index, defaultTimeout) as any;
  const retry = step.retry ?? 0;
  const repeat = step.repeat ?? 1;
  const retryDelayMs = step.retryDelayMs ?? 100;
  if (!Number.isInteger(retry) || retry < 0 || retry > 5) throw new MinecraftCliError("SCENARIO_RETRY_INVALID", `Step ${label} retry must be from 0 to 5.`, 400);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new MinecraftCliError("SCENARIO_REPEAT_INVALID", `Step ${label} repeat must be from 1 to 100.`, 400);
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30_000) throw new MinecraftCliError("SCENARIO_RETRY_INVALID", `Step ${label} retryDelayMs must be from 0 to 30000.`, 400);
  const assertions = step.assertions ?? step.assert ?? [];
  if (!Array.isArray(assertions) || assertions.length > 64) throw new MinecraftCliError("SCENARIO_ASSERTION_INVALID", `Step ${label} assertions must be an array of at most 64 entries.`, 400);
  for (const assertion of assertions) evaluateAssertions({}, [assertion]);
  if (step.capture !== undefined && (!step.capture || typeof step.capture !== "object" || Array.isArray(step.capture))) {
    throw new MinecraftCliError("SCENARIO_CAPTURE_INVALID", `Step ${label} capture must be an object.`, 400);
  }
  const capture = step.capture ?? {};
  for (const [key, spec] of Object.entries(capture)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(key)) throw new MinecraftCliError("SCENARIO_CAPTURE_INVALID", `Step ${label} capture key '${key}' is invalid.`, 400);
    const selector = typeof spec === "string" ? spec : (spec as any)?.selector;
    if (typeof selector !== "string" || !selector.trim()) throw new MinecraftCliError("SCENARIO_CAPTURE_INVALID", `Step ${label} capture '${key}' requires a selector.`, 400);
  }
  return { ...base, retry, repeat, retryDelayMs, assertions, capture } as Required<Pick<V2ActionStep, "name" | "args" | "timeoutMs" | "when">> & V2ActionStep;
}

function validateWhen(value: unknown, index: number): StepCondition {
  const when = value ?? "success";
  if (!( ["success", "failure", "always"] as unknown[]).includes(when)) throw new MinecraftCliError("SCENARIO_STEP_INVALID", `Step ${index + 1} when must be success, failure, or always.`, 400);
  return when as StepCondition;
}

function validateName(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.length > 120) throw new MinecraftCliError("SCENARIO_STEP_INVALID", "Scenario step name is invalid.", 400);
  return value;
}

function validateBoolean(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new MinecraftCliError("SCENARIO_STEP_INVALID", `${label} must be boolean.`, 400);
  return value;
}

async function executeV2Action(options: ScenarioOptions, step: ValidV2Action, variables: Record<string, unknown>) {
  const startedAt = Date.now();
  const initialArgs = step.args.map(value => interpolateString(value, { ...variables, repeatIndex: 0, attemptIndex: 0 }));
  const failureContext = await prepareFailureContext(options, step.name, initialArgs);
  const repetitions: any[] = [];
  let final: any;
  for (let repetition = 0; repetition < (step.repeat ?? 1); repetition++) {
    let attemptResult: any;
    for (let attempt = 0; attempt <= (step.retry ?? 0); attempt++) {
      const args = step.args.map(value => interpolateString(value, { ...variables, repeatIndex: repetition, attemptIndex: attempt }));
      const child = await runCliChild(options, args, step.timeoutMs);
      const response = parseResponse(child.stdout, child.stderr, child.error);
      const resolvedVariables = { ...variables, repeatIndex: repetition, attemptIndex: attempt };
      const assertions = (step.assertions ?? step.assert ?? []).map(assertion => Object.fromEntries(
        Object.entries(assertion).map(([key, value]) => [key, typeof value === "string" && !["path", "selector", "matches"].includes(key) ? interpolateString(value, resolvedVariables) : value])
      ));
      const assertionFailures = child.status === 0 && response?.ok === true ? evaluateAssertions(response, assertions) : [];
      const passed = child.status === 0 && response?.ok === true && assertionFailures.length === 0;
      attemptResult = { passed, args: redactArgv(args), exitCode: child.status, response: redactSecrets(response), assertionFailures, attempt: attempt + 1 };
      if (passed) break;
      if (attempt < (step.retry ?? 0) && (step.retryDelayMs ?? 0) > 0) await new Promise(resolve => setTimeout(resolve, step.retryDelayMs));
    }
    repetitions.push(attemptResult);
    final = attemptResult;
    if (!attemptResult.passed) break;
  }
  const captures: Record<string, unknown> = {};
  const captureFailures: any[] = [];
  if (final?.passed) {
    for (const [key, rawSpec] of Object.entries(step.capture ?? {})) {
      const selector = typeof rawSpec === "string" ? rawSpec : rawSpec.selector;
      const value = selectJson(final.response, selector);
      if (value === undefined) captureFailures.push({ code: "SCENARIO_CAPTURE_MISSING", variable: key, selector });
      else captures[key] = value;
    }
  }
  const ok = Boolean(final?.passed) && captureFailures.length === 0 && repetitions.length === (step.repeat ?? 1);
  const capsuleFile = ok ? undefined : await writeFailureCapsule(options, step.name, initialArgs, final, failureContext);
  await deleteFailureCheckpoint(options, failureContext);
  return {
    name: step.name,
    action: actionName(step.args),
    ok,
    ...( !ok && step.allowFailure ? { allowedFailure: true } : {}),
    exitCode: final?.exitCode,
    attempts: repetitions.reduce((sum, entry) => sum + entry.attempt, 0),
    repeatsCompleted: repetitions.filter(entry => entry.passed).length,
    durationMs: Date.now() - startedAt,
    response: final?.response,
    assertionFailures: [...(final?.assertionFailures ?? []), ...captureFailures],
    ...(capsuleFile ? { capsuleFile } : {}),
    captures,
    ...(repetitions.length > 1 ? { repetitions } : {})
  };
}

interface FailureContext {
  session?: string;
  checkpointLabel?: string;
  checkpointFile?: string;
  eventCursor?: number;
  daemonBefore?: unknown;
}

async function prepareFailureContext(options: ScenarioOptions, stepName: string, args: string[]): Promise<FailureContext> {
  const session = scenarioSessionName(args);
  const daemonBefore = readJsonIfPresent(path.join(options.workspace, ".minecraft-cli", "runtime", "daemon.json"));
  if (!session) return { daemonBefore };
  const checkpointLabel = `__capsule-${safeFilePart(stepName).slice(0, 24)}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  const checkpoint = await runDiagnostic(options, ["session", "checkpoint", session, "--label", checkpointLabel]);
  if (!checkpoint?.ok) return { session, daemonBefore };
  return {
    session,
    checkpointLabel,
    checkpointFile: checkpoint.data?.file,
    eventCursor: checkpoint.data?.eventCursor,
    daemonBefore
  };
}

async function writeFailureCapsule(options: ScenarioOptions, stepName: string, args: string[], final: any, context: FailureContext) {
  const status = await runDiagnostic(options, ["status"]);
  const probeAfter = await runDiagnostic(options, ["probe", "status"]);
  const probeDiagnostics = probeAfter?.ok && probeAfter.data?.available ? await runDiagnostic(options, ["probe", "diagnostics"]) : undefined;
  const stateDiff = context.session && context.checkpointLabel
    ? await runDiagnostic(options, ["session", "diff", context.session, "--baseline", context.checkpointLabel])
    : { ok: true, data: { available: false, reason: "pre_step_checkpoint_unavailable" } };
  const events = context.session && context.eventCursor !== undefined
    ? await runDiagnostic(options, ["session", "events", context.session, "--after", String(context.eventCursor), "--limit", "100"])
    : { ok: true, data: { available: false, reason: "event_cursor_unavailable" } };
  const daemonAfter = readJsonIfPresent(path.join(options.workspace, ".minecraft-cli", "runtime", "daemon.json"));
  const visualSession = scenarioVisualSessionName(args);
  const screenshot = visualSession
    ? await runDiagnostic(options, ["visual", "screenshot", visualSession, "--label", `failure-${safeFilePart(stepName)}`, "--region", "auto"])
    : undefined;
  const capsule = redactSecrets({
    version: 1,
    kind: "minecraft-cli-failure-capsule",
    createdAt: new Date().toISOString(),
    step: { name: stepName, args: redactArgv(args), exitCode: final?.exitCode },
    assertionFailures: final?.assertionFailures ?? [],
    response: final?.response,
    session: context.session,
    before: { checkpointFile: context.checkpointFile, eventCursor: context.eventCursor, daemon: context.daemonBefore },
    after: { daemon: daemonAfter, status, probe: probeAfter, probeDiagnostics, stateDiff, events },
    ...(screenshot?.ok ? { visualEvidence: { file: screenshot.data?.file, crops: screenshot.data?.cropAnalysis?.crops?.map((crop: any) => crop.file) ?? [] } } : {})
  });
  const capsuleDir = path.join(options.workspace, ".minecraft-cli", "runs", "capsules");
  fs.mkdirSync(capsuleDir, { recursive: true });
  const file = path.join(capsuleDir, `${timestampFilePart()}-${safeFilePart(stepName)}.failure.json`);
  fs.writeFileSync(file, `${JSON.stringify(capsule, null, 2)}\n`, "utf8");
  return file;
}

async function deleteFailureCheckpoint(options: ScenarioOptions, context: FailureContext) {
  if (!context.session || !context.checkpointLabel) return;
  await runDiagnostic(options, ["session", "checkpoint-delete", context.session, "--label", context.checkpointLabel]);
}

async function runDiagnostic(options: ScenarioOptions, args: string[]) {
  const child = await runCliChild(options, args, 15_000);
  return parseResponse(child.stdout, child.stderr, child.error) as any;
}

function scenarioSessionName(args: string[]) {
  if (args[0] !== "session" || !args[1] || !args[2] || args[1] === "list") return undefined;
  return /^[a-zA-Z0-9_-]{1,32}$/.test(args[2]) ? args[2] : undefined;
}

function scenarioVisualSessionName(args: string[]) {
  if (args[0] === "actor" && ["interact-role", "actions", "click-action"].includes(args[1] ?? "") && args[2]) {
    return /^[a-zA-Z0-9_-]{1,32}$/.test(args[2]) ? args[2] : undefined;
  }
  if (args[0] !== "visual" || !args[1] || !args[2] || ["launch", "prepare", "stop", "prune"].includes(args[1])) return undefined;
  return /^[a-zA-Z0-9_-]{1,32}$/.test(args[2]) ? args[2] : undefined;
}

function readJsonIfPresent(file: string) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return undefined; }
}

function runCliChild(options: ScenarioOptions, args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [options.cliFile, "--json", "--compact", "--workspace", options.workspace, ...args], {
      cwd: options.workspace,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (status: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_BUFFER_BYTES) child.kill();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_BUFFER_BYTES) child.kill();
    });
    child.once("error", error => finish(null, error));
    child.once("exit", code => finish(code));
    const timer = setTimeout(() => {
      child.kill();
      finish(null, Object.assign(new Error(`Step timed out after ${timeoutMs}ms.`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
  });
}

function flattenV2Results(results: any[]) {
  return results.flatMap(result => result.action === "parallel" ? result.children : [result]);
}

function redactArgv(args: string[]) {
  const result = [...args];
  for (let index = 0; index < result.length; index++) {
    if (/^--?(?:token|secret|password|authorization|cookie|credential|device-code)$/i.test(result[index]) && index + 1 < result.length) result[++index] = "[redacted]";
  }
  return result.map(value => String(redactSecrets(value)));
}

function readScenario(file: string): ScenarioDefinition {
  const resolved = path.resolve(file);
  let value: any;
  try {
    value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new MinecraftCliError("SCENARIO_READ_FAILED", `Could not read scenario JSON: ${error instanceof Error ? error.message : String(error)}`, 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MinecraftCliError("SCENARIO_INVALID", "Scenario must be a JSON object.", 400);
  if (value.version !== undefined && value.version !== 1 && value.version !== 2) throw new MinecraftCliError("SCENARIO_VERSION_UNSUPPORTED", "Only scenario versions 1 and 2 are supported.", 400);
  if (value.name !== undefined && (typeof value.name !== "string" || value.name.length > 120)) throw new MinecraftCliError("SCENARIO_INVALID", "Scenario name must be a string of at most 120 characters.", 400);
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > MAX_STEPS) {
    throw new MinecraftCliError("SCENARIO_INVALID", `Scenario must contain 1 to ${MAX_STEPS} steps.`, 400);
  }
  if (value.timeoutMs !== undefined) validateTimeout(value.timeoutMs, "Scenario timeoutMs");
  return value as ScenarioDefinition;
}

function validateStep(step: any, index: number, defaultTimeout?: number) {
  if (!step || typeof step !== "object" || Array.isArray(step)) throw new MinecraftCliError("SCENARIO_STEP_INVALID", `Step ${index + 1} must be an object.`, 400);
  if (!Array.isArray(step.args) || step.args.length === 0 || step.args.length > 128 || step.args.some((value: unknown) => typeof value !== "string" || value.length > 8192)) {
    throw new MinecraftCliError("SCENARIO_STEP_INVALID", `Step ${index + 1} args must contain 1 to 128 strings.`, 400);
  }
  if (!ALLOWED_ROOT_COMMANDS.has(step.args[0])) {
    throw new MinecraftCliError("SCENARIO_COMMAND_BLOCKED", `Step ${index + 1} cannot run root command '${step.args[0]}'.`, 400);
  }
  if (step.name !== undefined && (typeof step.name !== "string" || step.name.length > 120)) throw new MinecraftCliError("SCENARIO_STEP_INVALID", `Step ${index + 1} name is invalid.`, 400);
  const when = step.when ?? "success";
  if (!(["success", "failure", "always"] as unknown[]).includes(when)) throw new MinecraftCliError("SCENARIO_STEP_INVALID", `Step ${index + 1} when must be success, failure, or always.`, 400);
  const timeoutMs = step.timeoutMs ?? defaultTimeout ?? 120_000;
  validateTimeout(timeoutMs, `Step ${index + 1} timeoutMs`);
  if (step.allowFailure !== undefined && typeof step.allowFailure !== "boolean") throw new MinecraftCliError("SCENARIO_STEP_INVALID", `Step ${index + 1} allowFailure must be boolean.`, 400);
  if (step.includeResponse !== undefined && typeof step.includeResponse !== "boolean") throw new MinecraftCliError("SCENARIO_STEP_INVALID", `Step ${index + 1} includeResponse must be boolean.`, 400);
  return { ...step, name: step.name ?? `step-${index + 1}`, when: when as StepCondition, timeoutMs } as Required<Pick<ScenarioStep, "name" | "args" | "timeoutMs" | "when">> & ScenarioStep;
}

function validateTimeout(value: unknown, label: string) {
  if (!Number.isInteger(value) || Number(value) < 100 || Number(value) > MAX_TIMEOUT_MS) {
    throw new MinecraftCliError("SCENARIO_TIMEOUT_INVALID", `${label} must be an integer from 100 to ${MAX_TIMEOUT_MS}.`, 400);
  }
}

function parseResponse(stdout: string, stderr: string, processError?: Error) {
  if (processError) return { ok: false, error: { code: (processError as any).code === "ETIMEDOUT" ? "SCENARIO_STEP_TIMEOUT" : "SCENARIO_STEP_PROCESS_FAILED", message: processError.message } };
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return {
      ok: false,
      error: {
        code: "SCENARIO_STEP_OUTPUT_INVALID",
        message: "Step did not return valid JSON.",
        ...(stderr.trim() ? { stderr: stderr.trim().slice(0, 4000) } : {}),
        ...(stdout.trim() ? { stdout: stdout.trim().slice(0, 4000) } : {})
      }
    };
  }
}

function actionName(args: string[]) {
  return args.slice(0, args[0] === "status" || args[0] === "cleanup" ? 1 : 2).join(" ");
}

function safeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "scenario";
}

function timestampFilePart() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
