import { useState } from "react";
import { Text, Box, useInput } from "ink";

/** A selectable entry in the session picker list. */
export interface SessionInfo {
  /** Display label (session name or file basename). */
  label: string;
  /** Absolute path to the session jsonl file. */
  path: string;
  /** Creation/modification time for display. */
  mtime: Date;
}

interface SessionPickerProps {
  sessions: SessionInfo[];
  onPick: (session: SessionInfo) => void;
  onCancel: () => void;
}

/**
 * SessionPicker overlay: lists previous sessions for the current cwd.
 *
 * `↑`/`↓` move the selection, `Enter` resumes the highlighted session,
 * `Esc` cancels. Owns its own `useInput` — `InputBox` is unmounted while
 * this overlay is open.
 */
export function SessionPicker({ sessions, onPick, onCancel }: SessionPickerProps): React.ReactElement {
  const [cursor, setCursor] = useState(0);

  useInput((_value, key) => {
    if (key.upArrow) {
      setCursor((c) => (c - 1 + sessions.length) % Math.max(sessions.length, 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % Math.max(sessions.length, 1));
      return;
    }
    if (key.return) {
      const chosen = sessions[cursor];
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
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Resume session — ↑↓ select · Enter resume · Esc cancel</Text>
      {sessions.length === 0 ? (
        <Text dimColor>No sessions found.</Text>
      ) : (
        sessions.map((s, i) => (
          <Text key={s.path} color={i === cursor ? "cyan" : undefined}>
            {i === cursor ? "› " : "  "}
            {s.label}{"  "}
            <Text dimColor>({s.mtime.toLocaleString()})</Text>
          </Text>
        ))
      )}
    </Box>
  );
}
