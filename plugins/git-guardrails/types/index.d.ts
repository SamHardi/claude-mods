/** Set by /guardrails allow; the next refused command runs and it resets. */
export type GitGuardrailsAllowOnce = boolean

declare module 'claude-code' {
  interface PluginState {
    'git-guardrails': { allowOnce: GitGuardrailsAllowOnce }
  }
}
