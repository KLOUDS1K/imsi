/**
 * Making the page harder to walk off with by accident.
 *
 * Be clear about what this is: a speed bump, not protection. Anyone who wants
 * a copy can still take one — the bytes have to reach the browser to be shown,
 * and a network panel or a screenshot is always one step away. What it stops is
 * the effortless path: the right-click "Save image as…", the drag onto the
 * desktop, the long-press "Add to Photos", and dragging across the page to
 * select and copy what is written on it. That is the path almost everyone who
 * takes something they should not have takes.
 *
 * Typing is left alone throughout. Blocking any of this inside a text field
 * would cost selection, paste, spellcheck and undo — real losses to everybody,
 * in exchange for nothing, because there is nothing in a text field worth
 * guarding.
 */

/** Somewhere the browser's own menu is worth more than the deterrent. */
function isTypeable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]'))
}

export function initImageGuard(): void {
  /*
   * Listening on the document rather than on each image: the explorer redraws
   * its whole pane on every navigation, so anything wired per element would
   * have to be wired again on every render and would be missed exactly once
   * before someone noticed.
   *
   * These run in the bubble phase, after the folder and photo cards have
   * already opened their own menus — those call preventDefault themselves, so
   * a second call here changes nothing for them.
   */
  document.addEventListener('contextmenu', (event) => {
    if (isTypeable(event.target)) return
    event.preventDefault()
  })

  document.addEventListener('dragstart', (event) => {
    if (isTypeable(event.target)) return
    event.preventDefault()
  })

  /*
   * Dragging across the page to highlight it. CSS does the real work — see the
   * `user-select` rules in base.css — and this is what answers the ways round
   * it: a double-click, a shift-click that extends a selection from somewhere
   * the rules missed, and the engines that honour the event but not the
   * property.
   */
  document.addEventListener('selectstart', (event) => {
    if (isTypeable(event.target)) return
    event.preventDefault()
  })

  // And the last step of it, in case a selection was made some other way.
  document.addEventListener('copy', (event) => {
    if (isTypeable(event.target)) return
    event.preventDefault()
  })
}
