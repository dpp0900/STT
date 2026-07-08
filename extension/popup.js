document.getElementById("open-app")?.addEventListener("click", () => {
  chrome.tabs.create({ url: "http://localhost:3000/" }).catch(() => {});
});
