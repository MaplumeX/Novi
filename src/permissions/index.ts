export type {
  ApprovalChoice,
  ApprovalRequest,
  Approver,
  CanonicalPermissionIntent,
  PermissionDecision,
  PermissionErrorCode,
  PermissionGrant,
  PermissionLevel,
  PermissionRule,
  PermissionSource,
  ResolvedPermissionRule,
  ResolvedPermissions,
} from "./types.js";

export {
  DEFAULT_PERMISSION_RULES,
  resolveIntentPermission,
  resolvePermissionsFromSettings,
  resolveWholeToolPermission,
} from "./policy.js";

export {
  NonInteractiveApprover,
  PermissionGate,
  SessionPermissionStore,
  createNonInteractivePermissionGate,
  createPermissionGate,
} from "./gate.js";
export type { PermissionGateOptions, ToolCallEvent, ToolCallGateResult } from "./gate.js";

export { WorkspaceScopeGuard, containsPath, grantKey } from "./scope.js";
export { decodePermissionError, encodePermissionError, findPermissionError } from "./errors.js";

export { TuiApprover } from "./tui-approver.js";
export type { PermissionPromptState } from "./tui-approver.js";
