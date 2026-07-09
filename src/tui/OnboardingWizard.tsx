import { useState } from "react";
import { Text, Box, useInput, render } from "ink";
import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getBuiltinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model, Api } from "@earendil-works/pi-ai";
import { writeSettings } from "../settings.js";
import { writeCredentials, injectCredentialsIntoEnv } from "../credentials.js";
import { getNoviDir, getSessionsDir } from "../config.js";
import { theme } from "./theme.js";
import { providerEnvKeys } from "../onboarding.js";
import { DEFAULT_PROVIDER, DEFAULT_MODEL_ID, bootstrap, type BootstrapOptions } from "../bootstrap.js";
import { renderApp } from "./App.js";

/** What the wizard hands back on completion. */
export interface OnboardingResult {
  provider: string;
  model: string;
  credentials: Record<string, string>;
}

interface OnboardingWizardProps {
  env: ExecutionEnv;
  onComplete: (result: OnboardingResult) => void;
  onCancel: () => void;
}

type Step = "provider" | "key" | "model";

/**
 * First-run setup wizard. Three steps:
 *   1. Provider select (all built-in providers, alphabetical)
 *   2. API-key entry (one input per accepted env var; ambient-only providers
 *      show a guidance message and skip entry)
 *   3. Model select (provider's model list; default highlighted)
 *
 * Esc steps back; Esc on step 1 / Ctrl-C cancels. On finish: persists
 * credentials.json (0600) + settings.json (provider/model) then calls
 * `onComplete`.
 */
export function OnboardingWizard({
  env,
  onComplete,
  onCancel,
}: OnboardingWizardProps): React.ReactElement {
  const providers = useState(() => [...getBuiltinProviders()].sort())[0];
  const [step, setStep] = useState<Step>("provider");
  const [providerCursor, setProviderCursor] = useState(0);
  const [modelCursor, setModelCursor] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [models, setModels] = useState<Model<Api>[]>([]);
  const [keyBuffer, setKeyBuffer] = useState("");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [envKeyList, setEnvKeyList] = useState<string[]>([]);
  const [envKeyIndex, setEnvKeyIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      onCancel();
      return;
    }

    if (step === "provider") {
      if (key.upArrow) {
        setProviderCursor((c) => (c - 1 + providers.length) % providers.length);
        return;
      }
      if (key.downArrow) {
        setProviderCursor((c) => (c + 1) % providers.length);
        return;
      }
      if (key.return) {
        const provider = providers[providerCursor]!;
        const envKeys = providerEnvKeys(provider);
        setSelectedProvider(provider);
        const list = getBuiltinModels(provider);
        setModels(list);
        if (envKeys && envKeys.length > 0) {
          setEnvKeyList(envKeys);
          setEnvKeyIndex(0);
          setKeyBuffer("");
          setKeys({});
          setStep("key");
        } else {
          // Ambient-only provider — no env var to capture; go to model select.
          setStep("model");
        }
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      return;
    }

    if (step === "key") {
      const currentKey = envKeyList[envKeyIndex];
      if (key.return) {
        const trimmed = keyBuffer.trim();
        if (!trimmed) {
          setError("Enter a value (or Ctrl-C to cancel).");
          return;
        }
        const nextKeys = { ...keys, [currentKey!]: trimmed };
        setKeys(nextKeys);
        setKeyBuffer("");
        setError(null);
        if (envKeyIndex + 1 < envKeyList.length) {
          setEnvKeyIndex((i) => i + 1);
        } else {
          setStep("model");
        }
        return;
      }
      if (key.escape) {
        setStep("provider");
        return;
      }
      if (key.backspace || key.delete) {
        setKeyBuffer((prev) => prev.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta || !value) return;
      setKeyBuffer((prev) => prev + value);
      return;
    }

    // step === "model"
    if (key.upArrow) {
      setModelCursor((c) => (c - 1 + models.length) % models.length);
      return;
    }
    if (key.downArrow) {
      setModelCursor((c) => (c + 1) % models.length);
      return;
    }
    if (key.return) {
      const model = models[modelCursor]!;
      void finish(selectedProvider!, model.id);
      return;
    }
    if (key.escape) {
      // Back to key entry if there were keys, else to provider select.
      setStep(envKeyList.length > 0 ? "key" : "provider");
      return;
    }
  });

  async function finish(provider: string, modelId: string): Promise<void> {
    try {
      const targetPath = path.join(getNoviDir(), "settings.json");
      await writeSettings(env, targetPath, {
        defaultProvider: provider,
        defaultModel: modelId,
      });
      if (Object.keys(keys).length > 0) {
        await writeCredentials(env, keys);
      }
      onComplete({ provider, model: modelId, credentials: keys });
    } catch (e) {
      setError(`Setup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const lines: React.ReactElement[] = [];

  lines.push(
    <Text key="title" bold>
      Novi first-run setup
    </Text>,
  );

  if (step === "provider") {
    lines.push(
      <Text key="hint" color={theme.dim}>
        Select a provider · ↑↓ navigate · Enter confirm · Esc/Ctrl-C cancel
      </Text>,
    );
    // Show a scroll window around the cursor.
    const window = 12;
    const start = Math.max(0, providerCursor - Math.floor(window / 2));
    const end = Math.min(providers.length, start + window);
    for (let i = start; i < end; i++) {
      const p = providers[i]!;
      const marker = i === providerCursor ? "›" : " ";
      lines.push(
        <Text key={p} color={i === providerCursor ? theme.accent : undefined}>
          {marker} {p}
        </Text>,
      );
    }
    if (providers.length > window) {
      lines.push(
        <Text key="more" color={theme.dim}>
          ({providers.length} providers · scroll for more)
        </Text>,
      );
    }
  } else if (step === "key") {
    const currentKey = envKeyList[envKeyIndex];
    lines.push(
      <Text key="hint" color={theme.dim}>
        Provider: {selectedProvider} · Enter your {currentKey} · Esc back
      </Text>,
    );
    lines.push(
      <Text key="prompt">
        <Text color={theme.dim}>{currentKey}: </Text>
        {keyBuffer ? "•".repeat(keyBuffer.length) : <Text color={theme.dim}>(hidden)</Text>}
      </Text>,
    );
    if (envKeyList.length > 1) {
      lines.push(
        <Text key="progress" color={theme.dim}>
          credential {envKeyIndex + 1} of {envKeyList.length}
        </Text>,
      );
    }
    lines.push(
      <Text key="hint2" color={theme.dim}>
        The value is stored in ~/.novi/credentials.json (0600) and never shown again.
      </Text>,
    );
  } else {
    // step === "model"
    const defaultIdx = selectedProvider === DEFAULT_PROVIDER
      ? models.findIndex((m) => m.id === DEFAULT_MODEL_ID)
      : 0;
    const cursor = modelCursor;
    lines.push(
      <Text key="hint" color={theme.dim}>
        Provider: {selectedProvider} · Pick a model · ↑↓ navigate · Enter confirm · Esc back
      </Text>,
    );
    const window = 12;
    const start = Math.max(0, cursor - Math.floor(window / 2));
    const end = Math.min(models.length, start + window);
    for (let i = start; i < end; i++) {
      const m = models[i]!;
      const marker = i === cursor ? "›" : " ";
      const isDefault = i === defaultIdx;
      lines.push(
        <Text key={m.id} color={i === cursor ? theme.accent : undefined}>
          {marker} {m.id}
          {isDefault ? <Text color={theme.dim}> (recommended)</Text> : null}
        </Text>,
      );
    }
  }

  if (error) {
    lines.push(<Text key="error" color={theme.status.error}>{error}</Text>);
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {lines}
    </Box>
  );
}

/** Render the wizard standalone; on completion bootstrap + render the app. */
export async function renderOnboardingWizard(
  options: BootstrapOptions,
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });

  await new Promise<void>((resolve) => {
    let resolved = false;
    const instance = render(
      <OnboardingWizard
        env={env}
        onCancel={() => {
          if (resolved) return;
          resolved = true;
          instance.unmount();
          process.stderr.write("Setup cancelled.\n");
          process.exit(1);
        }}
        onComplete={async (result) => {
          if (resolved) return;
          resolved = true;
          instance.unmount();
          // Inject the just-stored key into the env so bootstrap's getAuth
          // sees it without relying on a fresh process.env reload.
          injectCredentialsIntoEnv(result.credentials, process.env);
          try {
            const { TuiApprover } = await import("../permissions/index.js");
            const tuiApprover = new TuiApprover();
            const bootstrapped = await bootstrap({ ...options, approver: tuiApprover });
            renderApp(bootstrapped, getSessionsDir(), tuiApprover);
            resolve();
          } catch (e) {
            process.stderr.write(
              `Novi: bootstrap failed after setup: ${e instanceof Error ? e.message : String(e)}\n`,
            );
            process.exit(1);
          }
        }}
      />,
    );
  });
}
