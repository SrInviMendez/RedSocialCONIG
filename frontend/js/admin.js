document.addEventListener("DOMContentLoaded", async () => {
  const container = document.getElementById("regionStatus");

  function renderRegion(name, data) {
    const card = document.createElement("div");
    card.className = "col-md-6";

    const panel = document.createElement("div");
    panel.className = "card border-0 shadow-sm h-100";

    const body = document.createElement("div");
    body.className = "card-body";

    const title = document.createElement("h5");
    title.textContent = name;

    const status = document.createElement("p");
    const active =
      data.status === "active" && data.mongodb === "connected";

    status.className = active ? "text-success mb-2" : "text-danger mb-2";
    status.textContent = active ? "Activo · MongoDB conectado" : "No disponible";

    const details = document.createElement("small");
    details.className = "text-secondary";
    details.textContent = active
      ? `Latencia MongoDB: ${data.latencyMs} ms · Solicitudes activas: ${data.load?.activeRequests ?? 0}`
      : "Se revisará nuevamente en la próxima actualización.";

    body.append(title, status, details);
    panel.append(body);
    card.append(panel);
    container.append(card);
  }

  async function loadStatus() {
    container.replaceChildren();

    const message = document.getElementById("statusMessage");
    message.textContent = "Consultando infraestructura...";

    try {
      const data = await ConigAPI.request(
        "/api/health?includePeer=1",
        { auth: false, timeoutMs: 20000 }
      );

      const regions = data.regions || {};

      renderRegion("Nodo principal", regions[data.region] || data);

      const peer = Object.entries(regions)
        .find(([key]) => key !== data.region);

      if (peer) renderRegion("Nodo compañero", peer[1]);

      message.textContent = "Estado actualizado correctamente.";

    } catch (error) {
      message.textContent = error.message;
    }
  }

  document.getElementById("refreshStatus")
    .addEventListener("click", loadStatus);

  await loadStatus();
});