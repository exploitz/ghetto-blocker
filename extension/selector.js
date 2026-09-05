/* selector.js -- compact unique CSS-selector heuristic
 *
 * Strategy (in order of preference):
 *   1. #id on the element itself (stable across reloads)
 *   2. tag + unique class combination (filters out volatile state classes)
 *   3. Positional :nth-child chain, anchored to the nearest #id ancestor
 *
 * SHORTCUT: heuristic selector; trigger: picker repeatedly mis-targets
 *           -> swap in @medv/finder for a smarter shortest-unique selector.
 */

/* global uniqueSelector */
function uniqueSelector(el) {
  // 1. Stable id on the element itself
  if (el.id && /^[a-z_-][\w-]*$/i.test(el.id)) {
    return '#' + CSS.escape(el.id);
  }

  const tag = el.tagName.toLowerCase();

  // 2. Tag + class combo that uniquely identifies one element on this page.
  //    Exclude common volatile classes (active, hover, open, etc.) that change
  //    on interaction and would produce selectors that miss on reload.
  if (el.classList.length > 0) {
    const stable = [...el.classList].filter(c =>
      !/^(active|hover|focus|selected|open|closed|disabled|is-|has-|js-|ng-|v-|on-)/.test(c)
    );
    if (stable.length > 0) {
      const cls = stable.map(c => '.' + CSS.escape(c)).join('');
      const sel = tag + cls;
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch { /* invalid selector -- fall through */ }
    }
  }

  // 3. Positional :nth-child path, stopping at a stable #id ancestor
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    // Anchor to an ancestor id (but not the element itself -- already checked above)
    if (node !== el && node.id && /^[a-z_-][\w-]*$/i.test(node.id)) {
      parts.unshift('#' + CSS.escape(node.id));
      break;
    }
    const parent = node.parentElement;
    if (!parent) break;
    const idx = [...parent.children].indexOf(node) + 1;
    parts.unshift(node.tagName.toLowerCase() + ':nth-child(' + idx + ')');
    node = parent;
  }

  return parts.join(' > ') || tag;
}
