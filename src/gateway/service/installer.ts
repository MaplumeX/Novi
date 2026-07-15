import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createServiceManifest,
  diffUnits,
  hashUnit,
  renderGatewayUnit,
  validateGatewayServiceSpec,
} from "./unit.js";
import { assertSystemdAvailable, enableLinger, lingerState, runSystemctl } from "./systemd.js";
import {
  NOVI_GATEWAY_UNIT,
  type CommandRunner,
  type GatewayServiceManifest,
  type GatewayServiceSpec,
} from "./types.js";

export interface GatewayServiceInstallerOptions {
  runner: CommandRunner;
  spec: GatewayServiceSpec;
  unitPath: string;
  manifestPath: string;
  preflight: () => Promise<void>;
  now?: () => Date;
}

export interface InstallServiceOptions {
  replace?: boolean;
  enable?: boolean;
  start?: boolean;
  linger?: boolean;
}

export interface InstallServiceResult {
  action: "install";
  changed: boolean;
  installed: boolean;
  enabled: boolean;
  started: boolean;
  linger: "enabled" | "disabled" | "unknown";
  note?: string;
}

export interface UninstallServiceResult {
  action: "uninstall";
  removed: boolean;
  linger: "enabled" | "disabled" | "unknown";
  note: string;
}

export class GatewayServiceInstaller {
  constructor(private readonly options: GatewayServiceInstallerOptions) {}

  async install(input: InstallServiceOptions = {}): Promise<InstallServiceResult> {
    await assertSystemdAvailable(this.options.runner);
    const spec = validateGatewayServiceSpec(this.options.spec);
    await validateInstallFiles(spec);
    await this.options.preflight();

    const candidate = renderGatewayUnit(spec);
    const current = await readSafeOptional(this.options.unitPath, "systemd unit");
    const manifest = await readManifestForExplicitOverride(
      this.options.manifestPath,
      input.replace === true,
    );
    const identical =
      current !== undefined &&
      manifest !== undefined &&
      current === candidate &&
      manifest.unitSha256 === hashUnit(current) &&
      manifest.unitPath === this.options.unitPath;
    if (current !== undefined && !identical && !input.replace) {
      throw new Error(
        `existing ${NOVI_GATEWAY_UNIT} differs; rerun with --replace after reviewing:\n${diffUnits(current, candidate)}`,
      );
    }
    if (current === undefined && manifest !== undefined && !input.replace) {
      throw new Error("service manifest exists without its unit; inspect it or use --replace");
    }

    if (!identical) {
      const nextManifest = createServiceManifest(
        spec,
        this.options.unitPath,
        candidate,
        (this.options.now ?? (() => new Date()))(),
      );
      await publishUnitAndManifest(
        this.options.unitPath,
        candidate,
        this.options.manifestPath,
        nextManifest,
      );
      await runSystemctl(this.options.runner, ["daemon-reload"]);
    }

    let enabled = false;
    let started = false;
    if (input.enable !== false && input.start !== false) {
      await runSystemctl(this.options.runner, ["enable", "--now", NOVI_GATEWAY_UNIT]);
      enabled = true;
      started = true;
    } else {
      if (input.enable !== false) {
        await runSystemctl(this.options.runner, ["enable", NOVI_GATEWAY_UNIT]);
        enabled = true;
      }
      if (input.start !== false) {
        await runSystemctl(this.options.runner, ["start", NOVI_GATEWAY_UNIT]);
        started = true;
      }
    }
    if (input.linger) await enableLinger(this.options.runner);
    const linger = await lingerState(this.options.runner);
    return {
      action: "install",
      changed: !identical,
      installed: true,
      enabled,
      started,
      linger,
      ...(linger === "disabled" && !input.linger
        ? { note: "service starts after login; use --linger for boot without login" }
        : {}),
    };
  }

  async uninstall(force = false): Promise<UninstallServiceResult> {
    await assertSystemdAvailable(this.options.runner);
    const current = await readSafeOptional(this.options.unitPath, "systemd unit");
    const manifest = await readManifestForExplicitOverride(this.options.manifestPath, force);
    if (current === undefined) {
      if (manifest !== undefined) await unlink(this.options.manifestPath);
      return {
        action: "uninstall",
        removed: false,
        linger: await lingerState(this.options.runner),
        note: "service unit was already absent; linger was not changed",
      };
    }
    const owned =
      manifest !== undefined &&
      manifest.unitPath === this.options.unitPath &&
      manifest.unitSha256 === hashUnit(current);
    if (!owned && !force) {
      throw new Error(
        "service unit is modified or foreign; use --force to remove the regular file",
      );
    }
    await runSystemctl(this.options.runner, ["disable", "--now", NOVI_GATEWAY_UNIT]);
    await unlink(this.options.unitPath);
    await unlink(this.options.manifestPath).catch((error: unknown) => {
      if (readErrorCode(error) !== "ENOENT") throw error;
    });
    await runSystemctl(this.options.runner, ["daemon-reload"]);
    return {
      action: "uninstall",
      removed: true,
      linger: await lingerState(this.options.runner),
      note: `${force && !owned ? "force removed modified unit; " : ""}linger was not changed`,
    };
  }
}

export async function validateEnvironmentFile(filePath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    throw new Error(`environment file is unavailable: ${errorMessage(error)}`);
  }
  const uid = process.getuid?.();
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (uid !== undefined && stats.uid !== uid) ||
    (stats.mode & 0o177) !== 0
  ) {
    throw new Error(
      "environment file must be a current-user regular file with mode 0600 or stricter",
    );
  }
}

async function validateInstallFiles(spec: GatewayServiceSpec): Promise<void> {
  for (const [label, filePath, executable] of [
    ["Node executable", spec.nodePath, true],
    ["compiled Novi CLI", spec.cliPath, false],
  ] as const) {
    const stats = await lstat(filePath).catch((error: unknown) => {
      throw new Error(`${label} is unavailable: ${errorMessage(error)}`);
    });
    if (stats.isSymbolicLink() || !stats.isFile())
      throw new Error(`${label} must be a regular file`);
    if (executable && (stats.mode & 0o111) === 0) throw new Error(`${label} is not executable`);
  }
  if (spec.environmentFile) await validateEnvironmentFile(spec.environmentFile);
}

async function publishUnitAndManifest(
  unitPath: string,
  unit: string,
  manifestPath: string,
  manifest: GatewayServiceManifest,
): Promise<void> {
  const suffix = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const unitStage = `${unitPath}.${suffix}.tmp`;
  const manifestStage = `${manifestPath}.${suffix}.tmp`;
  const unitOld = `${unitPath}.${suffix}.old`;
  const manifestOld = `${manifestPath}.${suffix}.old`;
  await mkdir(path.dirname(unitPath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(manifestPath), 0o700);
  await writeFile(unitStage, unit, { mode: 0o644 });
  await chmod(unitStage, 0o644);
  await writeFile(manifestStage, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(manifestStage, 0o600);
  const hadUnit = await exists(unitPath);
  const hadManifest = await exists(manifestPath);
  let unitPublished = false;
  let manifestPublished = false;
  try {
    if (hadUnit) await rename(unitPath, unitOld);
    if (hadManifest) await rename(manifestPath, manifestOld);
    await rename(unitStage, unitPath);
    unitPublished = true;
    await rename(manifestStage, manifestPath);
    manifestPublished = true;
    await rm(unitOld, { force: true });
    await rm(manifestOld, { force: true });
  } catch (error) {
    if (unitPublished) await rm(unitPath, { force: true });
    if (manifestPublished) await rm(manifestPath, { force: true });
    if (hadUnit) await rename(unitOld, unitPath).catch(() => undefined);
    if (hadManifest) await rename(manifestOld, manifestPath).catch(() => undefined);
    throw error;
  } finally {
    await rm(unitStage, { force: true });
    await rm(manifestStage, { force: true });
  }
}

export function decodeServiceManifest(value: unknown): GatewayServiceManifest {
  if (!isObject(value) || value.version !== 1 || value.unitName !== NOVI_GATEWAY_UNIT) {
    throw new Error("invalid Novi systemd service manifest");
  }
  if (
    typeof value.unitPath !== "string" ||
    !path.isAbsolute(value.unitPath) ||
    typeof value.unitSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.unitSha256) ||
    typeof value.installedAt !== "string" ||
    !Array.isArray(value.argv) ||
    !value.argv.every((item) => typeof item === "string") ||
    typeof value.cwd !== "string" ||
    typeof value.noviHome !== "string"
  ) {
    throw new Error("invalid Novi systemd service manifest");
  }
  return value as unknown as GatewayServiceManifest;
}

async function readManifestOptional(filePath: string): Promise<GatewayServiceManifest | undefined> {
  const raw = await readPrivateOptional(filePath, "service manifest");
  if (raw === undefined) return undefined;
  try {
    return decodeServiceManifest(JSON.parse(raw));
  } catch (error) {
    throw new Error(`cannot trust service manifest: ${errorMessage(error)}`);
  }
}

async function readManifestForExplicitOverride(
  filePath: string,
  override: boolean,
): Promise<GatewayServiceManifest | undefined> {
  try {
    return await readManifestOptional(filePath);
  } catch (error) {
    if (override) return undefined;
    throw error;
  }
}

async function readPrivateOptional(filePath: string, label: string): Promise<string | undefined> {
  try {
    const stats = await lstat(filePath);
    const uid = process.getuid?.();
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      (stats.mode & 0o177) !== 0 ||
      (uid !== undefined && stats.uid !== uid)
    ) {
      throw new Error(`${label} is not a private current-user regular file`);
    }
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function readSafeOptional(filePath: string, label: string): Promise<string | undefined> {
  try {
    const stats = await lstat(filePath);
    const uid = process.getuid?.();
    if (stats.isSymbolicLink() || !stats.isFile() || (uid !== undefined && stats.uid !== uid)) {
      throw new Error(`${label} is not a current-user regular file`);
    }
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
