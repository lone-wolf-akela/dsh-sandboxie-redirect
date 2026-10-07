/**
 * Browser half of dsh-sandboxie-redirect.
 *
 * 1. A chip in the conversation header naming the Sandboxie box this workspace
 *    is bound to.
 * 2. A glyph for the `copy-on-write` row of the permission dropdown.
 *
 * Loading contract (copied from the shipped client halves, not guessed): a
 * client half is NOT an ES module. It is evaluated as
 * `window.__ModuleLoader__.load({ id, factory: (require) => … })` and receives a
 * CJS-style `require` for the shell's shared modules. `id` must equal the
 * package name, and the shell discovers this file through the package.json
 * `dsh.client` declaration plus `exports["./client"]`.
 *
 * ABOUT SURFACE 2 — read this before changing it.
 * The dropdown takes its icons from a CLOSED design-set map (`permissionGlyphs`
 * in the permission-presets client half — a plain literal, with no registration
 * point), so a fourth preset gets none, and the row carries no id: its label is
 * the only handle. Three earlier revisions found that row by its SHAPE and each
 * held in one selection state and not the other, because the shipped menu
 * appends a selection check to the selected row. So this revision keys nothing
 * on the shape: it flags the LABEL SPAN (structurally identical selected or
 * not) and draws a real 16px SVG at metrics MEASURED from the product's own
 * icons, so the glyph lands in the icon column like its neighbours.
 *
 * The ladder is deliberately fail-safe, per row, in this order:
 *   1. the preset's configured name carries a glyph (`❐ 写时复制`), so an icon
 *      exists even if every line below fails;
 *   2. an attribute on the label span makes the stylesheet draw the real SVG;
 *   3. only once `getComputedStyle` CONFIRMS that pseudo-element exists is the
 *      text glyph stripped from the label, so a failure at step 2 leaves the
 *      configured glyph in place instead of removing it.
 * Nothing is ever inserted into React's tree — adopt that as a rule here: the
 * shipped menu renders a positional child array, so an extra foreign child can
 * make React patch the wrong slot. Attribute + generated stylesheet only.
 */
window.__ModuleLoader__.load({
  // The module-loader id must equal the package name exactly, scope included:
  // the shell keys its client-plugin registry by this string.
  id: "@lone-wolf-akela/dsh-sandboxie-redirect",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    /**
     * The header row that already holds 「创造模式」 (agent-preset, order -10)
     * and 「n 个后台任务」 (job-list, order 20). Sitting after both puts this
     * chip beside them instead of in the far-right icon group.
     */
    const HEADER_SLOT = "conversation.session.header.actions";
    const HEADER_CELL = "sandbox-box";
    const HEADER_ORDER = 30;

    /** Machine value of the preset that binds a conversation to a box. */
    const PRESET_ID = "copy-on-write";

    // ---------------------------------------------------------------------
    // Surface 1: the workspace's sandbox name in the conversation header
    // ---------------------------------------------------------------------

    const chipStyle = {
      // Match the neighbouring chips: the shell's secondary label colour at the
      // same 13px/500 the header utilities use.
      color: "var(--dsw-alias-label-secondary)",
      fontSize: "13px",
      fontWeight: 500,
      lineHeight: "20px",
      display: "inline-flex",
      alignItems: "center",
      gap: "5px",
      minWidth: 0,
      maxWidth: "220px",
      overflow: "hidden",
      whiteSpace: "nowrap",
      userSelect: "text"
    };
    const dotStyle = {
      flex: "none",
      width: "6px",
      height: "6px",
      borderRadius: "50%",
      background: "var(--dsw-alias-state-business-primary, var(--dsw-alias-label-tertiary))"
    };
    const textStyle = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 };

    /**
     * One header chip: the box name, with the copy root in the tooltip.
     *
     * It appears only when BOTH facts hold, which together mean "this
     * conversation is redirecting into this box right now":
     *
     *  - the session's permission preset is copy-on-write (`permissions`), and
     *  - the host reports a box this workspace actually OWNS (`sandboxBox`).
     *
     * The host deliberately reports nothing until the box exists, because a
     * collision can only be resolved by looking at Sandboxie's own state. So
     * the chip shows up right after the first copy-on-write command — not on
     * merely selecting the preset — and disappears again when the preset leaves
     * copy-on-write or the box is deleted, which is what makes it readable as
     * "a sandbox is in play, and it is this one".
     */
    function SandboxBoxChip(props) {
      const permissions = props.useProjection("permissions");
      const sandbox = props.useProjection("sandboxBox");
      const preset = permissions === undefined || permissions === null ? undefined : permissions.currentValue;
      if (preset !== PRESET_ID) return null;
      const box = sandbox === undefined || sandbox === null ? undefined : sandbox.box;
      if (box === undefined || box === null || box === "") return null;
      const root = sandbox.root === undefined || sandbox.root === null ? box : sandbox.root;
      return React.createElement(
        "span",
        {
          style: chipStyle,
          title: `Sandboxie box: ${box}\nWorkspace writes pass through; everything else lands in this box's copy.\nCopy root: ${root}`,
          "aria-label": `Sandboxie box ${box}`
        },
        React.createElement("span", { style: dotStyle }),
        React.createElement("span", { style: textStyle }, box)
      );
    }

    // ---------------------------------------------------------------------
    // Surface 2: the glyph the shipped design set cannot supply
    // ---------------------------------------------------------------------

    /** Marks the label span; the stylesheet below is keyed on this attribute. */
    const LABEL_FLAG = "data-dsh-sbie-cow";
    /** Substring of the preset's configured display name, glyph present or not. */
    const PRESET_TEXT = "写时复制";
    /** The leading glyph in the configured name, which the SVG replaces once live. */
    const NAME_GLYPH = /^\s*\u2750\s+/u;
    /**
     * The two surfaces that render this preset's name, addressed by ARIA rather
     * than by hashed CSS-module class names:
     *  - the dropdown list (`role="menu"`),
     *  - the composer trigger, whose `aria-label` is built from the preset name.
     * Keeping the query scoped to these two is also what keeps the per-mutation
     * cost bounded — this observer runs while the transcript streams.
     */
    const SURFACE_SELECTOR = `[role="menu"], button[aria-label*="${PRESET_TEXT}"]`;

    const COPY_GLYPH =
      "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='5.6' y='5.6' width='8.4' height='8.4' rx='2'/%3E%3Cpath d='M10.4 3.6A2 2 0 0 0 8.4 1.9H3.9a2 2 0 0 0-2 2v4.5a2 2 0 0 0 1.7 1.97'/%3E%3C/svg%3E";

    const STYLE_TAG_ID = "dsh-sandboxie-redirect/permission-icon.css";
    let injectedMetrics = "";

    /**
     * Measure the product's own icons rather than guessing the metrics. A 16px
     * glyph with a hand-picked margin is exactly why the text-character version
     * looked off, so take the size from the product's SVG and the spacing from
     * its slot and row.
     */
    function measureIcon() {
      if (typeof document === "undefined" || document.body === null) return { size: 16, gap: 8 };
      const probe = document.querySelector('[role="menuitem"] > span > svg');
      if (probe === null) return { size: 16, gap: 8 };
      const svg = getComputedStyle(probe);
      const slot = probe.parentElement === null ? null : getComputedStyle(probe.parentElement);
      const row = probe.closest('[role="menuitem"]');
      const size = Math.round(Number.parseFloat(svg.width) || 16);
      const gap =
        Math.round(
          (Number.parseFloat(slot === null ? "" : slot.marginRight) || 0) +
            (Number.parseFloat(row === null ? "" : getComputedStyle(row).columnGap) || 0)
        ) || 8;
      return { size, gap };
    }

    function installStyles() {
      if (typeof document === "undefined" || document.head === null) return;
      if (typeof getComputedStyle !== "function") return;
      const { size, gap } = measureIcon();
      const metrics = `${size}/${gap}`;
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`);
      if (existing !== null && injectedMetrics === metrics) return;
      const css = [
        `span[${LABEL_FLAG}]::before {`,
        '  content: "";',
        "  display: inline-block;",
        "  vertical-align: -2px;",
        `  width: ${size}px;`,
        `  height: ${size}px;`,
        `  margin-right: ${gap}px;`,
        "  background-color: currentColor;",
        `  -webkit-mask-image: url("${COPY_GLYPH}");`,
        `  mask-image: url("${COPY_GLYPH}");`,
        "  -webkit-mask-repeat: no-repeat;",
        "  mask-repeat: no-repeat;",
        "  -webkit-mask-position: center;",
        "  mask-position: center;",
        "  -webkit-mask-size: contain;",
        "  mask-size: contain;",
        "}"
      ].join("\n");
      const tag = existing ?? document.createElement("style");
      tag.dataset.plugin = "dsh-sandboxie-redirect";
      tag.dataset.pluginCss = STYLE_TAG_ID;
      tag.textContent = css;
      if (existing === null) document.head.appendChild(tag);
      injectedMetrics = metrics;
    }

    /**
     * Flag the label span wherever this preset's name is rendered — the dropdown
     * row and the composer trigger — then drop the configured text glyph, but
     * only once the SVG is PROVEN to render, so this can never leave a surface
     * with no icon at all.
     *
     * Keyed on the label TEXT inside an ARIA-addressed surface, never on a row's
     * shape: the shipped menu appends a selection check to the selected row,
     * which is what made shape-based matching behave differently in the two
     * states.
     */
    function decoratePresetGlyphs(root) {
      // SWEEP FIRST: a span still flagged whose text is no longer this preset
      // must lose the flag. React reuses the label span across a preset change
      // and never removes an attribute it did not set, so without this the
      // generated glyph survives the switch — and the control then draws the
      // product's icon AND ours, side by side. (Observed exactly that after
      // selecting copy-on-write and then switching to another mode.)
      for (const stale of root.querySelectorAll(`[${LABEL_FLAG}]`)) {
        if (!(stale.textContent ?? "").includes(PRESET_TEXT)) stale.removeAttribute(LABEL_FLAG);
      }
      for (const surface of root.querySelectorAll(SURFACE_SELECTOR)) {
        for (const label of surface.querySelectorAll("span")) {
          if (!(label.textContent ?? "").includes(PRESET_TEXT)) continue;
          // Only the innermost span: a wrapper that merely contains the label
          // must not be flagged, or the glyph would be drawn twice.
          if (label.querySelector("span") !== null) continue;
          // A glyph the product drew sits BEFORE the label. Testing the
          // preceding siblings (not all children) matters on the trigger, whose
          // trailing chevron is also a span holding an SVG: counting it would
          // wrongly conclude that the product already drew this preset's icon.
          let leading = false;
          for (let node = label.previousElementSibling; node !== null; node = node.previousElementSibling) {
            if (node.querySelector("svg") !== null) {
              leading = true;
              break;
            }
          }
          if (leading) continue;
          if (!label.hasAttribute(LABEL_FLAG)) label.setAttribute(LABEL_FLAG, "1");
          if (getComputedStyle(label, "::before").content === "none") continue;
          const first = label.firstChild;
          if (first === null || first.nodeType !== 3) continue;
          const stripped = first.nodeValue.replace(NAME_GLYPH, "");
          // React restores the configured text on re-render, so this re-runs and
          // strips again; the two never fight, because React only ever writes the
          // value it was given.
          if (stripped !== first.nodeValue) first.nodeValue = stripped;
        }
      }
    }

    // ---------------------------------------------------------------------

    const inject = ["slots"];

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots !== undefined) {
        // `inject` waits for the slot's declaration lifetime, so this half may
        // load before the conversation UI declares its header row.
        ctx.slots.inject(HEADER_SLOT, () =>
          ctx.slots.register({ name: HEADER_SLOT, id: HEADER_CELL, order: HEADER_ORDER }, SandboxBoxChip)
        );
      }

      // The glyph shim is cosmetic and touches foreign DOM, so it must never be
      // able to take the header chip (registered above) down with it.
      try {
        if (typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.body !== null) {
          installStyles();
          decoratePresetGlyphs(document);
          const observer = new MutationObserver(() => {
            try {
              installStyles();
              decoratePresetGlyphs(document);
            } catch {
              /* never let a DOM surprise reach the shell */
            }
          });
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
          ctx.effect(() => () => observer.disconnect(), "dsh-sandboxie-redirect: preset glyph observer");
        }
      } catch {
        /* the chip stays; only the optional glyph is lost */
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
