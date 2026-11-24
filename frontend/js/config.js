(() => {
  const API_PRIMARY = "https://conig-redsocial-api.onrender.com";
  const API_SECONDARY = "https://conig-redsocial-node-cali.onrender.com";

  function getApiCandidates() {
    const unavailableUntil = Number(
      sessionStorage.getItem("conig_primary_unavailable_until") || 0
    );

    return Date.now() < unavailableUntil
      ? [API_SECONDARY, API_PRIMARY]
      : [API_PRIMARY, API_SECONDARY];
  }

  window.CONIG = {
    getApi: () => getApiCandidates()[0],
    getApiCandidates,

    markApiFailure(base) {
      if (base === API_PRIMARY) {
        sessionStorage.setItem(
          "conig_primary_unavailable_until",
          String(Date.now() + 30000)
        );
      }
    },

    markApiSuccess(base) {
      if (base === API_PRIMARY) {
        sessionStorage.removeItem("conig_primary_unavailable_until");
      }
    }
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