import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MinecraftCliError } from "./errors";

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
  steps: ScenarioStep[];
}

interface ScenarioOptions {
  file: string;
  workspace: string;
  cliFile: string;
  full?: boolean;
  dryRun?: boolean;
}

const ALLOWED_ROOT_COMMANDS = new Set(["status", "session", "visual", "cleanup"]);
const MAX_STEPS = 500;
const MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export function executeScenario(options: ScenarioOptions) {
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

function readScenario(file: string): ScenarioDefinition {
  const resolved = path.resolve(file);
  let value: any;
  try {
    value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new MinecraftCliError("SCENARIO_READ_FAILED", `Could not read scenario JSON: ${error instanceof Error ? error.message : String(error)}`, 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MinecraftCliError("SCENARIO_INVALID", "Scenario must be a JSON object.", 400);
  if (value.version !== undefined && value.version !== 1) throw new MinecraftCliError("SCENARIO_VERSION_UNSUPPORTED", "Only scenario version 1 is supported.", 400);
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
