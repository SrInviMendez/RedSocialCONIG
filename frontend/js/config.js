(() => {
  const API_PRIMARY = "https://conig-redsocial-api.onrender.com";
  const API_SECONDARY = "https://conig-redsocial-node-cali.onrender.com";

  const PRIMARY_UNAVAILABLE_KEY =
    "conig_api_primary_unavailable_until";

  const FAILOVER_COOLDOWN_MS = 2 * 60 * 1000;

  function normalize(url) {
    return String(url || "").replace(/\/+$/, "");
  }

  function getApiCandidates() {
    const unavailableUntil = Number(
      sessionStorage.getItem(PRIMARY_UNAVAILABLE_KEY) || 0
    );

    if (Date.now() < unavailableUntil) {
      return [API_SECONDARY, API_PRIMARY];
    }

    return [API_PRIMARY, API_SECONDARY];
  }

  function markApiFailure(url) {
    if (normalize(url) === API_PRIMARY) {
      sessionStorage.setItem(
        PRIMARY_UNAVAILABLE_KEY,
        String(Date.now() + FAILOVER_COOLDOWN_MS)
      );
    }
  }

  function markApiSuccess(url) {
    if (normalize(url) === API_PRIMARY) {
      sessionStorage.removeItem(PRIMARY_UNAVAILABLE_KEY);
    }
  }

  window.CONIG = {
    getApi: () => getApiCandidates()[0],
    getApiCandidates,
    markApiFailure,
    markApiSuccess
  };

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-logout]").forEach(button => {
      button.addEventListener("click", () => {
        sessionStorage.removeItem("conig_token");
        sessionStorage.removeItem("conig_user");
        window.location.href = "login.html";
      });
    });

    const user = JSON.parse(
      sessionStorage.getItem("conig_user") || "null"
    );

    document.querySelectorAll("[data-current-user]").forEach(element => {
      element.textContent =
        user?.displayName || user?.username || "Mi cuenta";
    });
  });
})();