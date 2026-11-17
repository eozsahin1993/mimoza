import { useEffect } from "react";

/**
 * Jumps to the URL's #anchor once the page has rendered. These pages draw
 * their text with React, so the browser's own jump on load looks for the
 * heading before it exists and leaves the page at the top. Waits for the
 * fonts too, since they reflow the page and would move the heading.
 */
export function useScrollToHash() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    document.fonts.ready.then(() => document.getElementById(id)?.scrollIntoView());
  }, []);
}
