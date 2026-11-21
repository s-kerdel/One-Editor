// Runs before first paint (classic, render-blocking, ~0.1 ms): applies the last-used theme, sidebar
// style/width/visibility, file overview column, zen mode, corner style, density, accent + folder colours and window frame so the static skeleton in
// index.html — and the first real frame — already look like the app. No inline script (CSP).
try {
  var d = document.documentElement, g = function (k) { return localStorage.getItem('sec-edit-' + k); }, l = JSON.parse(g('layout') || 'null'), s;
  // data-theme, data-ui (sidebar style: picks the matching skeleton), data-corners, data-density, data-folders (one colour)
  ['theme', 'ui', 'corners', 'density', 'folders'].forEach(function (k) { if (g(k)) d.setAttribute('data-' + k, g(k)); });
  if (l && l.w) d.style.setProperty('--skel-sidebar', l.w + 'px');
  if (l && l.sb === false) d.setAttribute('data-sb', '0'); // sidebar hidden: skeleton without it
  if (l && l.ov) d.setAttribute('data-ov', '1'); // file overview open: skeleton with the right column
  if (l && l.ow) d.style.setProperty('--skel-ov', l.ow + 'px');
  if (l && l.z) d.setAttribute('data-zen', String(l.z)); // zen mode: skeleton without the chrome ('on' / 'on status')
  // Window frame the desktop window really has (the preload bridge says; browser mode has none):
  // 'integrated' = no OS title bar, the tab strip hosts the window controls → its skeleton.
  if (window.secEditBridge && window.secEditBridge.frame === 'integrated') d.setAttribute('data-frame', 'integrated');
  // Accent / folder colour: the derived per-theme tokens were cached as ready-made stylesheets (app/accent.ts).
  ['accent', 'folder'].forEach(function (k) { if (g(k)) { s = document.createElement('style'); s.id = 'se-' + k; s.textContent = g(k); document.head.appendChild(s); } });
} catch (e) {}
