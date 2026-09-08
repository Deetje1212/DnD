/**
 * utils.js — small helper functions shared across the app.
 *
 * Important: crypto.randomUUID() only exists in "secure contexts"
 * (https, localhost, file://). Some test environments (e.g. opening the
 * site via a local network IP over plain http, or certain embedded
 * webviews/browsers) are NOT — in that case crypto.randomUUID is simply
 * missing, and any button that calls it (like "Play solo") throws an
 * uncaught error, so nothing visible happens. This fallback ensures a
 * usable unique ID is always generated, regardless of context.
 */
function genUUID() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    try {
      return window.crypto.randomUUID();
    } catch (e) {
      // fall through to the fallback below
    }
  }
  // RFC4122-like v4 fallback (no cryptographically strong randomness
  // needed, this ID is only used locally to tell players apart)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
window.genUUID = genUUID;

/**
 * Wraps an event handler so an unexpected error doesn't silently make
 * the button "die", but instead surfaces via a toast + console.error.
 * Supports both synchronous and async handlers.
 */
function safeHandler(fn) {
  return function (...args) {
    try {
      const result = fn.apply(this, args);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => reportHandlerError(err));
      }
      return result;
    } catch (err) {
      reportHandlerError(err);
    }
  };
}

function reportHandlerError(err) {
  console.error('[UI] Unexpected error:', err);
  if (window.UI && typeof window.UI.toast === 'function') {
    UI.toast('⚠ Something went wrong: ' + (err && err.message ? err.message : 'unknown error'));
  }
}

window.safeHandler = safeHandler;