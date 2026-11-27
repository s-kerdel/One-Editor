// Runs before first paint (classic, render-blocking, ~0.1 ms): applies the last-used theme, sidebar
// style/width/visibility, file overview column, zen mode, corner style, density, accent + folder colours and window frame so the static skeleton in
// index.html — and the first real frame — already look like the app. No inline script (CSP).
try {
  var d = document.documentElement, g = function (k) { return localStorage.getItem('sec-edit-' + k); }, l = JSON.parse(g('layout') || 'null'), s;
  // data-theme, data-ui (sidebar style: picks the matching skeleton), data-corners, data-density, data-folders (one colour)
  ['theme', 'ui', 'corners', 'density', 'folders'].forEach(function (k) { if (g(k)) d.setAttribute('data-' + k, g(k)); });
  if (l && l.w > 0) d.style.setProperty('--skel-sidebar', +l.w + 'px');
  if (l && l.sb === false) d.setAttribute('data-sb', '0'); // sidebar hidden: skeleton without it
  if (l && l.ov) d.setAttribute('data-ov', '1'); // file overview open: skeleton with the right column
  if (l && l.ow > 0) d.style.setProperty('--skel-ov', +l.ow + 'px');
  if (l && l.z) d.setAttribute('data-zen', String(l.z)); // zen mode: skeleton with the edge strips ('on' [+ ' status'] [+ ' ov'])
  // Window frame the desktop window really has (the preload bridge says; browser mode has none):
  // 'integrated' = no OS title bar, the tab strip hosts the window controls → its skeleton.
  if (window.secEditBridge && window.secEditBridge.frame === 'integrated') d.setAttribute('data-frame', 'integrated');
  // Accent / folder colour: only #rrggbb values are cached (app/accent.ts colorCache); the stylesheet is built
  // here, the same text accentCss / folderCss make. A cached value is never CSS of its own (localStorage is
  // shared by every folder's page): anything but the expected list of colours is ignored.
  var hex = function (v, n) { var c = (v || '').split(' '); for (var i = 0; i < c.length; i++) if (!/^#[0-9a-f]{6}$/.test(c[i])) return null; return c.length === n ? c : null; };
  var rgb = function (h) { var n = parseInt(h.slice(1), 16); return (n >> 16 & 255) + ', ' + (n >> 8 & 255) + ', ' + (n & 255); };
  var themed = function (pick, dark, light) { return '/*' + pick + '*/html:root:root{' + dark + "}html[data-theme='light']:root:root{" + light + "}@media (prefers-color-scheme:light){html[data-theme='system']:root:root{" + light + '}}'; };
  var tokens = function (a, strong, fg, soft, sel, ring) { return '--accent:' + a + ';--accent-strong:' + strong + ';--accent-soft:rgba(' + rgb(a) + ', ' + soft + ');--accent-fg:' + fg + ';--selection:rgba(' + rgb(a) + ', ' + sel + ');--focus-ring:rgba(' + rgb(a) + ', ' + ring + ')'; };
  var sheet = function (k, css) { s = document.createElement('style'); s.id = 'se-' + k; s.textContent = css; document.head.appendChild(s); };
  var c = hex(g('accent'), 7), f = hex(g('folder'), 3);
  if (c) sheet('accent', themed(c[0], tokens(c[1], c[2], c[3], 0.15, 0.28, 0.6), tokens(c[4], c[5], c[6], 0.11, 0.2, 0.5)));
  if (f) sheet('folder', themed(f[0], '--folder-color:' + f[1], '--folder-color:' + f[2]));
} catch (e) {}
