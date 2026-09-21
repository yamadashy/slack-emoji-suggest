/**
 * The provider registry: which ranking model scores the candidates.
 *
 * A provider exports
 * `{LABEL, rank({message, candidates, apiKey, signal}) -> Promise<{shortcode, p}[]>}`
 * (sorted descending). Only `jev` exists today; adding one means a sibling file
 * imported and listed below, and no change anywhere else.
 */
import * as jev from "./jev.js";

const PROVIDERS = { jev };

export const DEFAULT_PROVIDER = "jev";

export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}
