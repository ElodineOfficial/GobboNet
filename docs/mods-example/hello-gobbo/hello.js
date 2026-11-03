// Hello Gobbo: proves a mod's script ran, once. A script that has already run
// stops when the page reloads after the mod is switched off.
(function () {
  window.helloGobbo = (window.helloGobbo || 0) + 1;
  console.log('[hello-gobbo] loaded (run ' + window.helloGobbo + ')');
})();
