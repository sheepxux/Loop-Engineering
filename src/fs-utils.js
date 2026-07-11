import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

export function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

export function readData(filePath) {
  const raw = readText(filePath);
  if (filePath.endsWith(".json")) {
    return JSON.parse(raw);
  }
  return YAML.parse(raw);
}

export function writeYaml(filePath, value) {
  writeTextAtomic(filePath, YAML.stringify(value, { lineWidth: 100 }));
}

export function writeJson(filePath, value) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeTextAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  let handle;
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, value);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporary, filePath);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

export function assertCanWriteDir(dir, { force = false } = {}) {
  if (fs.existsSync(dir) && !force && fs.readdirSync(dir).length > 0) {
    throw new Error(`Refusing to overwrite non-empty directory: ${dir}. Pass --force to replace files.`);
  }
  fs.mkdirSync(dir, { recursive: true });
}

export function schemaPath(name) {
  const file = {
    loop: "loop.schema.json",
    state: "state.schema.json",
    evaluator: "evaluator.schema.json",
    "run-log": "run-log.schema.json",
    strategy: "strategy.schema.json",
    experiment: "experiment.schema.json",
    approval: "approval.schema.json"
  }[name];
  if (!file) {
    throw new Error(`Unknown schema "${name}". Expected loop, state, evaluator, run-log, strategy, experiment, or approval.`);
  }
  return path.join(repoRoot, "protocol", file);
}
