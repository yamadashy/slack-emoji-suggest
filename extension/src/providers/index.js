/**
 * The provider registry: which ranking model scores the candidates.
 *
 * A provider publishes itself into `self.Providers` as
 * `{LABEL, rank({message, candidates, apiKey, signal}) -> Promise<{shortcode, p}[]>}`
 * (sorted descending). Only `jev` exists today; adding one means a sibling file
 * loaded before this one, and no change anywhere else.
 *
 * Load order matters: every provider file, then this.
 */
(() => {
  const DEFAULT_PROVIDER = "jev";

  function getProvider(id) {
    const all = self.Providers || {};
    return all[id] || all[DEFAULT_PROVIDER];
  }

  self.ProviderRegistry = { DEFAULT_PROVIDER, getProvider };
})();
