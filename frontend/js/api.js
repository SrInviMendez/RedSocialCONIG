(() => {
  function canFailover(method, path) {
    const safeMethods = ["GET", "HEAD", "OPTIONS"];

    if (safeMethods.includes(method)) {
      return true;
    }

    // El login no modifica información, por lo que puede reintentarse.
    return (
      method === "POST" &&
      path.split("?")[0] === "/api/auth/login"
    );
  }

  function isUnavailableResponse(status, result) {
    if (status >= 500) {
      return true;
    }

    // Render puede responder con una página HTML al suspender un servicio.
    return (
      status === 404 &&
      typeof result === "string" &&
      /service suspended/i.test(result)
    );
  }

  async function request(path, options = {}) {
    const {
      method = "GET",
      data,
      auth = true,
      timeoutMs = 95000
    } = options;

    const requestMethod = method.toUpperCase();
    const retryAllowed = canFailover(requestMethod, path);

    const bases = [
      ...new Set(
        (CONIG.getApiCandidates?.() || [CONIG.getApi()])
          .filter(Boolean)
      )
    ];

    const headers = {};
    const token = sessionStorage.getItem("conig_token");

    if (auth && token) {
      headers.Authorization = `Bearer ${token}`;
    }

    let body;

    if (typeof FormData !== "undefined" && data instanceof FormData) {
      body = data;
    } else if (data !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(data);
    }

    let lastError = null;

    for (let index = 0; index < bases.length; index++) {
      const base = bases[index];
      const controller = new AbortController();

      const attemptTimeout = retryAllowed && bases.length > 1
        ? Math.min(timeoutMs, 18000)
        : timeoutMs;

      const timer = setTimeout(
        () => controller.abort(),
        attemptTimeout
      );

      try {
        const response = await fetch(`${base}${path}`, {
          method: requestMethod,
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
            result?.error || `Error HTTP ${response.status}`
          );

          error.status = response.status;

          if (
            retryAllowed &&
            index < bases.length - 1 &&
            isUnavailableResponse(response.status, result)
          ) {
            CONIG.markApiFailure?.(base);
            lastError = error;
            continue;
          }

          if (response.status === 401 && auth) {
            sessionStorage.removeItem("conig_token");
            sessionStorage.removeItem("conig_user");
          }

          throw error;
        }

        CONIG.markApiSuccess?.(base);
        return result;

      } catch (error) {
        const networkFailure =
          error.name === "AbortError" ||
          error instanceof TypeError;

        if (
          networkFailure &&
          retryAllowed &&
          index < bases.length - 1
        ) {
          CONIG.markApiFailure?.(base);
          lastError = error;
          continue;
        }

        if (error.name === "AbortError") {
          throw new Error(
            "El servidor tardó demasiado en responder."
          );
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

    throw lastError || new Error(
      "No se pudo conectar con ningún nodo de CONIG."
    );
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