// jsdom polyfills ported (subset) from survey-creator-core's vitest.setup.ts.
// These keep the creator's debounced/adorner code from throwing under jsdom.
import { beforeEach } from "vitest";
import { _setIsTouch } from "survey-core";

// jsdom does not implement the Web Animations API. The creator's adorner code
// calls getAnimations() inside debounced setTimeout callbacks; without this
// polyfill those callbacks throw after a test completes. An empty array
// matches the "no active animations" branch the production code handles.
if (typeof Element !== "undefined" && !(Element.prototype as any).getAnimations) {
  (Element.prototype as any).getAnimations = function () { return []; };
}
if (typeof Document !== "undefined" && !(Document.prototype as any).getAnimations) {
  (Document.prototype as any).getAnimations = function () { return []; };
}

// jsdom returns CSS keywords (e.g. "medium") for unset border-width and
// "content-box" boxSizing, which survey-core's dimension math parses to NaN
// ("NaNpx"). Coerce those keyword/empty values to "0px".
if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
  const originalGetComputedStyle = window.getComputedStyle.bind(window);
  const numericPxProps = [
    "paddingTop", "paddingBottom", "paddingLeft", "paddingRight",
    "marginTop", "marginBottom", "marginLeft", "marginRight",
    "borderTopWidth", "borderBottomWidth", "borderLeftWidth", "borderRightWidth"
  ];
  (window as any).getComputedStyle = function (el: Element, pseudo?: string | null) {
    const cs = originalGetComputedStyle(el, pseudo);
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

beforeEach(() => {
  _setIsTouch(false);
});
