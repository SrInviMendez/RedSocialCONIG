(() => {
  async function request(path, options = {}) {
    const {
      method = "GET",
      data,
      auth = true,
      timeoutMs = 95000
    } = options;

    const headers = {};
    const token = sessionStorage.getItem("conig_token");

    if (auth && token) {
      headers.Authorization = `Bearer ${token}`;
    }

    let body;

    if (data instanceof FormData) {
      body = data;
    } else if (data !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(data);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(
        `${CONIG.getApi()}${path}`,
        {
          method,
          headers,
          body,
          cache: "no-store",
          signal: controller.signal
        }
      );

      const type = response.headers.get("content-type") || "";
      const result = type.includes("application/json")
        ? await response.json()
        : await response.text();

      if (!response.ok) {
        const error = new Error(
          result?.error || `Error HTTP ${response.status}`
        );

        error.status = response.status;

        if (response.status === 401 && auth) {
          sessionStorage.removeItem("conig_token");
          sessionStorage.removeItem("conig_user");
        }

        throw error;
      }

      return result;

    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("El servidor tardó demasiado en responder.");
      }

      if (error instanceof TypeError) {
        throw new Error(
          "No se pudo conectar con CONIG. Comprueba la disponibilidad del servicio."
        );
      }

      throw error;

    } finally {
      clearTimeout(timer);
    }
  }

  function requireAuth() {
    if (!sessionStorage.getItem("conig_token")) {
      window.location.href = "login.html";
      return false;
    }
    return true;
  }

  window.ConigAPI = { request, requireAuth };
})();