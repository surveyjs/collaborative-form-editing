// jsdom polyfills (subset) mirrored from survey-creator-core's vitest setup, so
// the Translation model's adorner/dimension code does not throw under jsdom when
// the integration test builds a real creator.

// jsdom does not implement the Web Animations API; survey-core's adorner code
// calls getAnimations() inside debounced callbacks.
if (typeof Element !== "undefined" && !(Element.prototype as any).getAnimations) {
  (Element.prototype as any).getAnimations = function () { return []; };
}
if (typeof Document !== "undefined" && !(Document.prototype as any).getAnimations) {
  (Document.prototype as any).getAnimations = function () { return []; };
}

// jsdom returns CSS keywords ("medium", "content-box") for unset box metrics,
// which survey-core's dimension math parses to NaN. Coerce those to "0px".
if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
  const original = window.getComputedStyle.bind(window);
  const numericPxProps = [
    "paddingTop", "paddingBottom", "paddingLeft", "paddingRight",
    "marginTop", "marginBottom", "marginLeft", "marginRight",
    "borderTopWidth", "borderBottomWidth", "borderLeftWidth", "borderRightWidth"
  ];
  (window as any).getComputedStyle = function (el: Element, pseudo?: string | null) {
    const cs = original(el, pseudo);
    return new Proxy(cs, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop === "string" && numericPxProps.indexOf(prop) !== -1) {
          if (!value || isNaN(parseFloat(value as string))) return "0px";
        }
        return value;
      }
    });
  };
}
