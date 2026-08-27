import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/** Per-instance Kiro ACP adapter contract. */
export interface KiroAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
