import { useState } from "react";
import { Text, Box, useInput } from "ink";
import { theme } from "./theme.js";
import type { ModelEntry } from "./commands.js";
import { Panel } from "./components/Panel.js";
import { SelectionRow } from "./components/SelectionRow.js";

interface ModelPickerProps {
  models: ModelEntry[];
  currentIndex: number;
  onPick: (entry: ModelEntry) => void;
  onCancel: () => void;
}

/**
 * ModelPicker overlay: lists models from every configured provider grouped by
 * provider, with the current model marked.
 *
 * `↑`/`↓` move the selection (wraps), `Enter` switches to the highlighted
 * model, `Esc` cancels. Owns its own `useInput` — `InputBox` is unmounted
 * while this overlay is open.
 */
export function ModelPicker({
  models,
  currentIndex,
  onPick,
  onCancel,
}: ModelPickerProps): React.ReactElement {
  const [cursor, setCursor] = useState(currentIndex);

  useInput((_value, key) => {
    if (key.upArrow) {
      setCursor((c) => (c - 1 + models.length) % Math.max(models.length, 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % Math.max(models.length, 1));
      return;
    }
    if (key.return) {
      const chosen = models[cursor];
      if (chosen) onPick(chosen);
      else onCancel();
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
  });

  return (
    <Panel title="Switch model" footer="↑↓ navigate · Enter switch · Esc cancel">
      <Box flexDirection="column">
        {models.length === 0 ? (
          <Text color={theme.text.muted}>No models available.</Text>
        ) : (
          models.map((model, index) => (
            <SelectionRow key={`${model.provider}/${model.id}`} selected={index === cursor}>
              {model.provider}/{model.id}
            </SelectionRow>
          ))
        )}
      </Box>
    </Panel>
  );
}
