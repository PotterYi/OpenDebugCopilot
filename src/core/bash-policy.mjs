// Commands that are safe to run without an extra confirmation in full mode.
// Keep this aligned with the CLI's historical build/test whitelist.
const SAFE_BASH = /^(?:\.\/)?(?:mvn|mvnw|gradle|gradlew|npm|pnpm|yarn|npx|python(?:3)?|pytest|go|dotnet|cargo)\b/i;
const SHELL_META = /[;&|<>`$()\n\r]/;
const RISKY_BASH = [
  /^(?:\.\/)?(?:npm|pnpm|yarn)\s+(?:install|i|add|remove|rm|uninstall|publish|deploy|link|unlink|pack)\b/i,
  /^go\s+(?:get|install|run|generate)\b/i,
  /^cargo\s+(?:publish|install|run|generate)\b/i,
  /^dotnet\s+(?:run|publish|tool)\b/i,
  /^(?:\.\/)?mvnw?\s+.*\bexec(?::exec)?\b/i,
];

/**
 * Classify a Bash command as safe/risky for the full-permission mode.
 * Safe commands are build/test toolchain invocations with no shell chaining;
 * everything else gets one explicit confirmation (or is rejected in CI).
 */
export function isSafeBashCommand(command) {
  const text = String(command ?? '').trim();
  if (!text) return false;
  if (SHELL_META.test(text)) return false;
  if (RISKY_BASH.some((pattern) => pattern.test(text))) return false;
  return SAFE_BASH.test(text);
}
