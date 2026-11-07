/* SPDX-License-Identifier: MIT */
"use strict";
const status = document.getElementById("status");
async function submit(accept) {
  const controls = [document.getElementById("accept"), document.getElementById("decline")];
  controls.forEach(button => button.disabled = true);
  status.textContent = "Saving privacy choice...";
  status.classList.remove("error");
  try {
    const result = await browser.runtime.sendMessage({
      type: accept ? "ACCEPT_PRIVACY" : "DECLINE_PRIVACY",
      cacheEnabled: accept && document.getElementById("save-cache").checked
    });
    status.textContent = result.status === "accepted" ?
      "Preferences saved. You can now use the extension popup." :
      "Declined. Translation is disabled until you accept.";
    if (accept) window.close();
  } catch (error) {
    status.textContent = String(error?.message || error);
    status.classList.add("error");
  } finally { controls.forEach(button => button.disabled = false); }
}
document.getElementById("accept").addEventListener("click", () => submit(true));
document.getElementById("decline").addEventListener("click", () => submit(false));
browser.runtime.sendMessage({type:"GET_PRIVACY_STATUS"}).then(result => {
  if (result.status === "accepted") status.textContent = "Privacy choice already accepted. You can change caching from the extension popup.";
  else if (result.status === "declined") status.textContent = "Translation is currently disabled.";
}).catch(() => {});
