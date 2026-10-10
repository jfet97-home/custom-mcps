import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Config, ConfigProvider, Effect, Redacted } from "effect";

const execFileAsync = promisify(execFile);

export const deploymentEnvironmentKeys = [
  "ATLASSIAN_SITE_URL",
  "ATLASSIAN_CLOUD_ID",
  "ATLASSIAN_AUTH_MODE",
  "ATLASSIAN_EMAIL",
  "ATLASSIAN_API_TOKEN",
  "ATLASSIAN_API_TOKEN_EXPIRES_ON",
] as const;

export type DeploymentEnvironmentKey = typeof deploymentEnvironmentKeys[number];
export type DeploymentEnvironment = Partial<Record<DeploymentEnvironmentKey, string>>;

const defaultComposeFile = join(homedir(), ".config", "mcpx", "atlassian-media.compose.yaml");
const existingContainer = "atlassian-media-atlassian-media-1";
const dockerContext = "desktop-linux";

type CliOptions = {
  composeFile: string;
  importFile?: string;
};

const usage = "Usage: deploy [--compose PATH] [--import-file PATH]";

const parseArgs = (args: readonly string[]): CliOptions => {
  const options: CliOptions = { composeFile: defaultComposeFile };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage}\n`);
      process.exit(0);
    }
    if (!value || value.startsWith("--")) throw new Error(usage);
    if (argument === "--compose") options.composeFile = value;
    else if (argument === "--import-file") options.importFile = value;
    else throw new Error(usage);
    index += 1;
  }
  options.composeFile = resolve(options.composeFile);
  if (options.importFile !== undefined) options.importFile = resolve(options.importFile);
  return options;
};

const isEnvironmentKey = (key: string): key is DeploymentEnvironmentKey =>
  (deploymentEnvironmentKeys as readonly string[]).includes(key);

export const parseDockerEnv = (output: string): DeploymentEnvironment => {
  const trimmed = output.trim();
  let lines: readonly unknown[];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("Docker inspect returned invalid environment data.");
    }
    if (!Array.isArray(parsed)) throw new Error("Docker inspect returned invalid environment data.");
    lines = parsed;
  } else {
    lines = trimmed.split(/\r?\n/);
  }

  const environment: DeploymentEnvironment = {};
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (isEnvironmentKey(key)) environment[key] = line.slice(separator + 1);
  }
  return environment;
};

const pickEnvironment = (source: NodeJS.ProcessEnv | Record<string, string>): DeploymentEnvironment => {
  const selected: DeploymentEnvironment = {};
  for (const key of deploymentEnvironmentKeys) {
    const value = source[key];
    if (typeof value === "string") selected[key] = value;
  }
  return selected;
};

const configShape = Config.all({
  siteUrl: Config.String("ATLASSIAN_SITE_URL"),
  cloudId: Config.String("ATLASSIAN_CLOUD_ID"),
  authMode: Config.String("ATLASSIAN_AUTH_MODE"),
  email: Config.String("ATLASSIAN_EMAIL"),
  apiToken: Config.Redacted("ATLASSIAN_API_TOKEN"),
  tokenExpiry: Config.withDefault(Config.String("ATLASSIAN_API_TOKEN_EXPIRES_ON"), ""),
});

type ValidatedConfig = Awaited<ReturnType<typeof loadConfig>>;

const loadConfig = async (provider: ConfigProvider.ConfigProvider) => {
  const values = await Effect.runPromise(Effect.provideService(configShape, ConfigProvider.ConfigProvider, provider));
  let site: URL;
  try {
    site = new URL(values.siteUrl);
  } catch {
    throw new Error("Required Atlassian configuration is missing or invalid.");
  }
  if (site.protocol !== "https:" || (site.hostname !== "atlassian.net" && !site.hostname.endsWith(".atlassian.net")) ||
    site.username || site.password || site.port || site.pathname !== "/" || site.search || site.hash ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(values.cloudId) ||
    values.authMode !== "scoped" || !values.email.trim() || !Redacted.value(values.apiToken).trim()) {
    throw new Error("Required Atlassian configuration is missing or invalid.");
  }
  return values;
};

const configToEnvironment = (config: ValidatedConfig): DeploymentEnvironment => ({
  ATLASSIAN_SITE_URL: config.siteUrl,
  ATLASSIAN_CLOUD_ID: config.cloudId,
  ATLASSIAN_AUTH_MODE: config.authMode,
  ATLASSIAN_EMAIL: config.email,
  ATLASSIAN_API_TOKEN: Redacted.value(config.apiToken),
  ...(config.tokenExpiry ? { ATLASSIAN_API_TOKEN_EXPIRES_ON: config.tokenExpiry } : {}),
});

const readImportedEnvironment = async (filePath: string): Promise<DeploymentEnvironment> => {
  let contents: string;
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error("The import file must be private.");
    }
    contents = await readFile(filePath, "utf8");
  } catch {
    throw new Error("The requested import file could not be read.");
  }
  try {
    const config = await loadConfig(ConfigProvider.fromDotEnvContents(contents));
    return configToEnvironment(config);
  } catch {
    throw new Error("Required Atlassian configuration is missing or invalid.");
  }
};

const inspectContainerEnvironment = async (): Promise<DeploymentEnvironment> => {
  let output: string;
  try {
    const result = await execFileAsync("docker", [
      "--context", dockerContext,
      "inspect",
      "--format", "{{json .Config.Env}}",
      existingContainer,
    ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    output = result.stdout;
  } catch {
    throw new Error("The existing media container environment could not be read; supply --import-file for the first migration.");
  }
  const environment = parseDockerEnv(output);
  if (Object.keys(environment).length === 0) {
    throw new Error("The existing media container has no reusable Atlassian configuration; supply --import-file.");
  }
  return environment;
};

const composeEnvironment = async (options: CliOptions): Promise<NodeJS.ProcessEnv> => {
  const previous = options.importFile === undefined
    ? await inspectContainerEnvironment()
    : await readImportedEnvironment(options.importFile);
  const merged: DeploymentEnvironment = { ...previous, ...pickEnvironment(process.env) };
  try {
    await loadConfig(ConfigProvider.fromEnv({ env: merged as Record<string, string> }));
  } catch {
    throw new Error("Required Atlassian configuration is missing or invalid.");
  }
  return { ...process.env, ...merged };
};

const runCompose = (composeFile: string, environment: NodeJS.ProcessEnv): Promise<void> => new Promise((resolvePromise, reject) => {
  const child = spawn("docker", [
    "--context", dockerContext,
    "compose", "-f", composeFile,
    "up", "-d", "--build",
  ], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once("error", () => reject(new Error("Docker Compose deployment failed.")));
  child.once("close", (code) => code === 0
    ? resolvePromise()
    : reject(new Error("Docker Compose deployment failed.")));
});

export const deploy = async (options: CliOptions): Promise<void> => {
  const environment = await composeEnvironment(options);
  await runCompose(options.composeFile, environment);
};

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    await deploy(parseArgs(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error && error.message === usage
      ? usage
      : error instanceof Error && error.message === "The existing media container environment could not be read; supply --import-file for the first migration."
        ? error.message
        : error instanceof Error && error.message === "The existing media container has no reusable Atlassian configuration; supply --import-file."
          ? error.message
          : error instanceof Error && error.message === "The requested import file could not be read."
            ? error.message
            : "Deployment failed because local configuration or Docker Compose is invalid.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
