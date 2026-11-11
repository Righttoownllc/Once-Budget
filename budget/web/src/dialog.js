// App-styled replacements for alert() and confirm(): same card, colours and light/dark theme as the
// rest of the app, instead of the plain Android/browser box. Both return promises; the host that
// draws them lives in main.jsx (DialogHost).
//
//   if (!(await ask('Delete this?', { ok: 'Delete', danger: true }))) return;
//   await tell('Saved.');
let show = null;
export const setDialogHost = fn => { show = fn; };

/** Yes/no question. Resolves true for the confirm button, false for Cancel, Back or a tap outside. */
export const ask = (message, opts = {}) =>
  new Promise(resolve => (show ? show({ message, cancel: 'Cancel', ok: 'OK', ...opts, resolve }) : resolve(window.confirm(message))));

/** Notice with one button. Resolves when dismissed. */
export const tell = (message, opts = {}) =>
  new Promise(resolve => (show ? show({ message, ok: 'OK', ...opts, cancel: null, resolve: () => resolve() }) : (window.alert(message), resolve())));
