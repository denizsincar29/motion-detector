export function speak(text, priority = "polite") {
  const el = document.createElement("div");
  el.setAttribute("aria-live", priority);
  el.classList.add("visually-hidden");
  document.body.appendChild(el);

  // aria-live regions only announce content set *after* they're in the DOM,
  // so the text is set on the next tick rather than at creation time.
  window.setTimeout(() => {
    el.textContent = text;
  }, 100);

  window.setTimeout(() => {
    el.remove();
  }, 1000);
}
