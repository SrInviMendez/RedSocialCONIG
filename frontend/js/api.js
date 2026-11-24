(() => {
  async function request(path, options = {}) {
    const {
      method = "GET",
      data,
      auth = true,
      timeoutMs = 95000
    } = options;

    const requestMethod = String(method).toUpperCase();
    const canRetryOnNetwork = ["GET", "HEAD", "OPTIONS"].includes(requestMethod);

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

    const bases = CONIG.getApiCandidates();
    let lastError = null;

    for (let index = 0; index < bases.length; index++) {
      const base = bases[index];
      const controller = new AbortController();

      const attemptTimeout = canRetryOnNetwork
        ? Math.min(timeoutMs, 12000)
        : timeoutMs;

      const timer = setTimeout(
        () => controller.abort(),
        attemptTimeout
      );

      try {
        const response = await fetch(`${base}${path}`, {
          method,
          headers,
          body,
          cache: "no-store",
          signal: controller.signal
        });

        const type = response.headers.get("content-type") || "";
        const result = type.includes("application/json")
          ? await response.json()
          : await response.text();

        if (!response.ok) {
          const error = new Error(
            typeof result === "string"
              ? `Error HTTP ${response.status}`
              : result?.error || `Error HTTP ${response.status}`
          );

          error.status = response.status;

          if (response.status === 404 || response.status >= 500) {
            CONIG.markApiFailure(base);
          }

          const canFailover =
            response.status === 404 ||
            (canRetryOnNetwork && response.status >= 500);

          if (canFailover && index < bases.length - 1) {
            lastError = error;
            continue;
          }

          if (response.status === 401 && auth) {
            sessionStorage.removeItem("conig_token");
            sessionStorage.removeItem("conig_user");
          }

          throw error;
        }

        CONIG.markApiSuccess(base);
        return result;

      } catch (error) {
        if (error.status) throw error;

        let normalizedError = error;

        if (error.name === "AbortError") {
          normalizedError = new Error(
            "El servidor tardó demasiado en responder."
          );
        } else if (error instanceof TypeError) {
          normalizedError = new Error(
            "No se pudo conectar con el nodo. Se comprobaron las regiones disponibles."
          );
        }

        CONIG.markApiFailure(base);

        if (canRetryOnNetwork && index < bases.length - 1) {
          lastError = normalizedError;
          continue;
        }

        throw normalizedError;

      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new Error("No hay nodos disponibles.");
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