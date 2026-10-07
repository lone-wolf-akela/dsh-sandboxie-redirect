/**
 * Model-facing note for copy-on-write sessions.
 *
 * The stock policy line (`sandbox:policy`, rendered by `dsh-sandbox-policy`)
 * describes the resolved MODE, which for this preset is truthfully
 * `workspace-write`. What it cannot say is that shell commands additionally run
 * inside a Sandboxie box whose out-of-workspace writes are redirected. This
 * plugin contributes exactly that sentence, and nothing when the preset is not
 * selected.
 *
 * No harness import is needed: the two services it uses arrive through cordis.
 */
import { REDIRECT_PRESET, redirectPolicyNote } from "./redirect.mjs";
import { rootForBox } from "./host.mjs";
import { boxNameFor } from "./naming.mjs";

export const name = "dsh-sandboxie-redirect-note";
export const inject = ["systemPrompt"];

export function apply(ctx) {
  ctx.inject(["systemPrompt", "sessionProjections"], (scope) => {
    const noteFor = (session) => {
      if (session === undefined) return "";
      try {
        const state = scope.get("sessionProjections").stateOf(session, "permissions");
        if (state?.preset !== REDIRECT_PRESET) return "";
        const cwd = session.header?.cwd;
        if (typeof cwd !== "string" || cwd.length === 0) return "";
        // Name the root Sandboxie is actually configured with, not the default
        // layout: the model is told to trust the env vars over this prose, but
        // the prose should not contradict them.
        return redirectPolicyNote(cwd, rootForBox(boxNameFor(cwd, "workspace-write")));
      } catch {
        return "";
      }
    };
    scope.systemPrompt.context({
      name: "sandbox:copy-on-write",
      order: scope.systemPrompt.getContextOrder("SANDBOX_POLICY") + 1,
      text: (context) => noteFor(context?.agent?.session)
    });
  });
}
