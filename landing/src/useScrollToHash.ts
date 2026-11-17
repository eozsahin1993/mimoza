import { useEffect } from "react";

/**
 * Jumps to the URL's #section once the page has rendered: these pages draw
 * their text with React, so the browser's own jump on load finds nothing.
 * It must never throw, because an error in an effect blanks the whole page;
 * a malformed hash or a browser without `document.fonts` just stays put.
 */
export function useScrollToHash() {
  useEffect(() => {
    try {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      const jump = () => document.getElementById(id)?.scrollIntoView();
      jump();
      // Again once the fonts arrive, since they reflow the page.
      document.fonts?.ready.then(jump, () => {});
    } catch {
      // Stay at the top.
    }
  }, []);
}
