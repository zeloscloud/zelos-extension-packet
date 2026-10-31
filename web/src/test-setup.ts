import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library unmounts after each test only when vitest globals are on; they are off here.
afterEach(cleanup);

// The panel keeps its view state in session storage, so each test starts without the last one's.
afterEach(() => window.sessionStorage.clear());

// jsdom has no matchMedia, which the SDK's theme bridge reads.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

// jsdom draws nothing: a canvas has no 2d context, and says so on every call.
HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext;
