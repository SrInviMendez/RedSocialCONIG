(() => {
  const API_BASE_URL =
    "https://conig-redsocial-api.onrender.com";

  window.CONIG = {
    getApi: () => API_BASE_URL
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