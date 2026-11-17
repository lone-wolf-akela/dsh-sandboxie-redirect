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
import { copyOnWriteSource, redirectPolicyNote, selectionKind } from "./redirect.mjs";
import { rootForBox } from "./host.mjs";
import { boxNameFor } from "./naming.mjs";

export const name = "dsh-sandboxie-redirect-note";
export const inject = ["systemPrompt"];

export function apply(ctx) {
  ctx.inject(["systemPrompt", "sessionProjections"], (scope) => {
    /**
     * The `permissions` projection state for one session, or undefined when the
     * projection cannot answer yet (it never throws into the prompt).
     */
    const stateOf = (session) => {
      try {
        return scope.get("sessionProjections")?.stateOf(session, "permissions");
      } catch {
        return undefined;
      }
    };
    /** The live session registry, so a delegated session can be traced to its parent. */
    const sessionsById = () => {
      const map = new Map();
      try {
        for (const candidate of scope.get("sessions")?.list?.() ?? []) map.set(String(candidate.id), candidate);
      } catch {
        /* no registry: no inheritance, which is the behaviour before this rule */
      }
      return map;
    };
    const noteFor = (session) => {
      if (session === undefined) return "";
      try {
        // A delegated session does NOT carry the preset itself — the harness
        // seeds only `auto`/`danger-full-access` and pins the child's approval
        // policy, so its projection reads `custom` — but its shell commands run
        // in the same box as its parent's. The note has to follow the runner,
        // not the projection, or a subagent would be told the wrong thing about
        // its own filesystem. Same rule as the provider (see copyOnWriteSource).
        const registry = sessionsById();
        const source = copyOnWriteSource(session, {
          selectionOf: (candidate) => selectionKind(stateOf(candidate)),
          parentOf: (id) => registry.get(String(id))
        });
        if (source === undefined) return "";
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
