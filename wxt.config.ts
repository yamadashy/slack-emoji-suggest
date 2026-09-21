import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

// Chrome MV3 only. The manifest below is the hand-written one this extension
// shipped before WXT; the version is the one in package.json, and the
// entrypoints/ directory supplies the background, content script and popup.
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
  // Nothing here relies on WXT's auto-imports: every shared module is imported
  // by name, which is what makes the old `self.X` globals unnecessary.
  imports: false,
  manifest: {
    name: "Slack Emoji Suggest",
    default_locale: "en",
    description: "__MSG_extensionDescription__",
    // Pins the extension ID to alemihiajbabhgfdgogganjphfkppeek, so an
    // installed copy keeps its storage across a re-install from a new zip.
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnPWsFSSznuU3PfONLXj/VYfoJvVpxGlDiJl5VGhXNt0UDyEN96vGgUNyixb4iIYnU+HfmEk5r+PgMtrp5RK4LwFMLcbmnvFqRGfUDqOKPZIUgOqQttrruGekvGFXcVnovJGFIaIpeAnTklHuUDu8bOOgG9lB9ny3GjBMpcmSlynfa7oeSFcZ/reP7odWX8gTxiV596EiL0sHfgymzL4D2fn2JZfzFZzBH4hOxt4fpmOASqHdQf3XTg8CUws1fX5QyrIE9Itbwgvd6fYW/IQ7jPi//aSDAImyXKLw63vtYm4MDPEg1P5dVsN/3tKiEMJS9m4A3KDmtierrZ4DDCnDWQIDAQAB",
    permissions: ["storage"],
    host_permissions: ["https://api.typesafe.ai/*", "https://app.slack.com/*"],
    action: {
      default_title: "Slack Emoji Suggest",
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
