document.addEventListener("DOMContentLoaded", async () => {
  if (!ConigAPI.requireAuth()) return;

  const message = document.getElementById("adminMessage");
  const usersBody = document.getElementById("adminUsers");
  const usersMessage = document.getElementById("usersMessage");
  const searchInput = document.getElementById("userSearch");
  let currentUser = null;
  let users = [];

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function renderRegion(name, data) {
    const column = node("div", "col-md-6");
    const card = node("div", "card border-0 shadow-sm h-100");
    const body = node("div", "card-body");
    const active = data && data.status === "active" && data.mongodb === "connected";
    body.append(node("h3", "h6 fw-bold", name));
    body.append(node("p", active ? "text-success mb-2" : "text-danger mb-2",
      active ? "Activo · MongoDB conectado" : "No disponible"));
    body.append(node("small", "text-secondary",
      active
        ? "Latencia MongoDB: " + (data.latencyMs ?? "—") + " ms · Solicitudes activas: " + (data.load?.activeRequests ?? 0)
        : "El nodo se comprobará nuevamente al actualizar."));
    card.append(body);
    column.append(card);
    return column;
  }

  function renderUsers() {
    const search = searchInput.value.trim().toLowerCase();
    const filtered = users.filter(user =>
      [user.username, user.displayName, user.email].some(value =>
        String(value || "").toLowerCase().includes(search)
      )
    );

    usersBody.replaceChildren();
    if (!filtered.length) {
      usersBody.append(node("tr", "", ""));
      const row = usersBody.lastElementChild;
      row.append(node("td", "text-secondary", "No se encontraron usuarios."));
      row.firstElementChild.colSpan = 5;
      return;
    }

    filtered.forEach(user => {
      const row = node("tr", "");
      const identityCell = node("td", "");
      const identity = node("div", "d-flex flex-column");
      identity.append(node("strong", "", user.displayName || user.username));
      identity.append(node("small", "text-secondary", "@" + user.username));
      identityCell.append(identity);

      row.append(identityCell);
      row.append(node("td", "small", user.email || "—"));
      row.append(node("td", "small text-capitalize", user.homeRegion || "—"));
      const roleCell = node("td", "");
      roleCell.append(node("span",
        user.role === "admin" ? "badge text-bg-primary" : "badge text-bg-light text-dark",
        user.role === "admin" ? "Administrador" : "Usuario"));
      row.append(roleCell);

      const actionCell = node("td", "");
      if (user.userId === currentUser.id) {
        actionCell.append(node("small", "text-secondary", "Tu cuenta"));
      } else {
        const isAdmin = user.role === "admin";
        const button = node("button",
          "btn btn-sm " + (isAdmin ? "btn-outline-danger" : "btn-outline-primary"),
          isAdmin ? "Retirar admin" : "Hacer admin");
        button.type = "button";
        button.addEventListener("click", () => changeRole(user, isAdmin ? "user" : "admin", button));
        actionCell.append(button);
      }
      row.append(actionCell);
      usersBody.append(row);
    });

    usersMessage.textContent = filtered.length + " usuario(s) mostrados. La lista incluye las cuentas replicadas en ambas regiones.";
  }

  async function changeRole(user, role, button) {
    const action = role === "admin" ? "dar permisos de administrador a" : "retirar los permisos administrativos de";
    if (!window.confirm("¿Quieres " + action + " @" + user.username + "?")) return;

    button.disabled = true;
    try {
      await ConigAPI.request("/api/admin/users/" + encodeURIComponent(user.userId) + "/role", {
        method: "PATCH",
        data: { role }
      });
      user.role = role;
      renderUsers();
      message.textContent = role === "admin"
        ? "@" + user.username + " ahora es administrador. El cambio se sincronizará con la otra región."
        : "Se retiraron los permisos de @" + user.username + ".";
      await loadOverview();
    } catch (error) {
      message.textContent = error.message;
      button.disabled = false;
    }
  }

  async function loadOverview() {
    const [overview, health] = await Promise.all([
      ConigAPI.request("/api/admin/overview"),
      ConigAPI.request("/api/health?includePeer=1", { auth: false, timeoutMs: 20000 }).catch(() => null)
    ]);

    document.getElementById("statUsers").textContent = overview.usersTotal;
    document.getElementById("statAdmins").textContent = overview.adminsTotal;
    document.getElementById("statPosts").textContent = overview.postsTotal;
    document.getElementById("statFollows").textContent = overview.followsTotal;
    document.getElementById("regionalStatusMessage").textContent =
      overview.partial ? "Estadísticas parciales: el otro nodo no respondió." : "Ambas regiones consultadas.";

    const regionContainer = document.getElementById("regionStatus");
    regionContainer.replaceChildren();
    if (health) {
      const regions = health.regions || {};
      const local = regions[health.region] || health;
      regionContainer.append(renderRegion("Nodo " + (local.region || "local"), local));
      const peer = Object.entries(regions).find(([key]) => key !== health.region);
      if (peer) regionContainer.append(renderRegion("Nodo " + peer[0], peer[1]));
      else if (health.region) {
        regionContainer.append(renderRegion("Nodo compañero", { status: "unavailable" }));
      }
    } else {
      regionContainer.append(renderRegion("Estado regional", { status: "unavailable" }));
    }
  }

  async function loadUsers() {
    const result = await ConigAPI.request("/api/admin/users");
    users = result.users || [];
    renderUsers();
  }

  async function refreshAll() {
    message.textContent = "Actualizando el panel...";
    try {
      await Promise.all([loadOverview(), loadUsers()]);
      message.textContent = "Panel actualizado correctamente.";
    } catch (error) {
      message.textContent = error.message;
    }
  }

  try {
    currentUser = await ConigAPI.request("/api/me");
    if (currentUser.isAdmin !== true) {
      window.location.replace("index.html");
      return;
    }
  } catch {
    window.location.replace("login.html");
    return;
  }

  searchInput.addEventListener("input", renderUsers);
  document.getElementById("refreshAdmin").addEventListener("click", refreshAll);
  await refreshAll();
  window.setInterval(() => {
    if (document.visibilityState === "visible") loadOverview().catch(() => {});
  }, 15000);
});
