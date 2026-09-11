/* Centered rounded launch card, expanded only after the main window has painted. */
(() => {
  const stage = document.getElementById("stage");
  let requested = false;
  const finish = () => {
    if (requested) return;
    requested = true;
    document.getElementById("status").textContent = "正在打开工作空间";
    window.halo.splashDone().catch(() => {});
  };
  window.halo.onSplashExpand(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => stage.classList.add("expand")));
  });
  setTimeout(finish, 1800);
  addEventListener("click", finish);
  addEventListener("keydown", finish);
})();
