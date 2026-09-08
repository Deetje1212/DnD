/**
 * utils.js — kleine hulpfuncties die overal gedeeld worden.
 *
 * Belangrijk: crypto.randomUUID() bestaat alleen in "secure contexts"
 * (https, localhost, file://). Sommige testomgevingen (bv. de site
 * openen via een lokaal netwerk-IP over gewoon http, of bepaalde
 * embedded webviews/browsers) zijn dat NIET — dan ontbreekt
 * crypto.randomUUID gewoon, en gooit elke knop die het aanroept
 * (zoals "Solo spelen") een onopgevangen fout, waardoor er niets
 * zichtbaars gebeurt. Deze fallback zorgt dat er altijd een bruikbaar
 * uniek ID gegenereerd wordt, ongeacht de context.
 */
function genUUID() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    try {
      return window.crypto.randomUUID();
    } catch (e) {
      // val terug op onderstaande fallback
    }
  }
  // RFC4122-achtige v4 fallback (geen crypto-sterke randomness nodig,
  // dit ID wordt alleen lokaal gebruikt om spelers te onderscheiden)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
window.genUUID = genUUID;

/**
 * Wrapt een event-handler zodat een onverwachte fout niet stil de knop
 * "laat doodvallen", maar zichtbaar wordt via een toast + console.error.
 * Ondersteunt zowel synchrone als async handlers.
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
  console.error('[UI] Onverwachte fout:', err);
  if (window.UI && typeof window.UI.toast === 'function') {
    UI.toast('⚠ Er ging iets mis: ' + (err && err.message ? err.message : 'onbekende fout'));
  }
}

window.safeHandler = safeHandler;