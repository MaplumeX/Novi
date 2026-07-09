import type { ImageContent } from "@earendil-works/pi-ai";
import type { PendingImage } from "../images/encode.js";

/**
 * Build harness prompt/steer/followUp options from pending images.
 * Empty pending → no `images` key (keeps the call shape identical to pure text).
 */
export function toPromptImages(
  pending: readonly PendingImage[],
): { images?: ImageContent[] } {
  if (pending.length === 0) return {};
  return { images: pending.map((p) => p.image) };
}

export interface ModelLike {
  provider: string;
  id: string;
  input?: readonly string[];
}

/**
 * Warn once when submitting images to a model that does not advertise image input.
 * Returns the notice string, or `undefined` when no warning is needed.
 */
export function nonVisionWarning(
  model: ModelLike,
  pendingCount: number,
): string | undefined {
  if (pendingCount <= 0) return undefined;
  const vision = Array.isArray(model.input) && model.input.includes("image");
  if (vision) return undefined;
  return `warning: model ${model.provider}/${model.id} does not advertise image input; images may be omitted`;
}
