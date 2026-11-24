document.addEventListener("DOMContentLoaded", async () => {
  if (!ConigAPI.requireAuth()) return;

  const grid = document.getElementById("suggestionsGrid");
  const message = document.getElementById("suggestionsMessage");
  const moreButton = document.getElementById("suggestionsMore");
  const pageSize = 16;
  let users = [];
  let visibleCount = 0;

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function updateFollowButton(user, button) {
    button.textContent = user.isFollowing ? "Siguiendo" : "Seguir";
    button.classList.toggle("btn-primary", !user.isFollowing);
    button.classList.toggle("btn-outline-secondary", user.isFollowing);
  }

  async function toggleFollow(user, button) {
    button.disabled = true;
    try {
      await ConigAPI.request(`/api/follows/${encodeURIComponent(user.userId)}`, {
        method: user.isFollowing ? "DELETE" : "POST"
      });
      user.isFollowing = !user.isFollowing;
      updateFollowButton(user, button);
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function createCard(user) {
    const column = node("div", "col-12 col-sm-6 col-lg-3");
    const card = node("article", "card user-card h-100");
    const body = node("div", "card-body d-flex flex-column align-items-center text-center");

    const profileLink = node("a", "user-card-profile-link text-decoration-none text-reset");
    profileLink.href = `perfil.html?userId=${encodeURIComponent(user.userId)}`;
    if (user.avatarUrl) {
      const avatar = node("img", "user-card-avatar");
      avatar.src = user.avatarUrl;
      avatar.alt = `Foto de perfil de ${user.username}`;
      avatar.loading = "lazy";
      profileLink.append(avatar);
    } else {
      profileLink.append(node("span", "user-card-avatar user-card-avatar-placeholder",
        (user.username || "U").charAt(0).toUpperCase()));
    }
    profileLink.append(node("strong", "user-card-name d-block mt-3", user.displayName || user.username));
    profileLink.append(node("span", "text-secondary small d-block", `@${user.username}`));
    body.append(profileLink);

    body.append(node("p", "user-card-bio text-secondary small mt-3 mb-2",
      user.bio || "Este perfil todavía no tiene descripción."));

    if (user.commonConnectionsCount > 0) {
      body.append(node("small", "text-primary mb-2", `${user.commonConnectionsCount} conexiones en común`));
    }

    const button = node("button", `btn btn-sm mt-auto ${user.isFollowing ? "btn-outline-secondary" : "btn-primary"}`,
      user.isFollowing ? "Siguiendo" : "Seguir");
    button.type = "button";
    button.addEventListener("click", () => toggleFollow(user, button));
    body.append(button);
    card.append(body);
    column.append(card);
    return column;
  }

  function renderNextPage() {
    const nextUsers = users.slice(visibleCount, visibleCount + pageSize);
    nextUsers.forEach(user => grid.append(createCard(user)));
    visibleCount += nextUsers.length;
    moreButton.classList.toggle("d-none", visibleCount >= users.length);
    moreButton.textContent = `Ver más personas (${Math.max(0, users.length - visibleCount)} restantes)`;
  }

  moreButton.addEventListener("click", renderNextPage);

  try {
    const result = await ConigAPI.request("/api/users");
    users = result.users || [];

    if (result.partial) {
      message.textContent = `Se encontraron ${users.length} perfiles, pero el otro nodo no respondió. Se muestran los perfiles disponibles.`;
    } else {
      message.textContent = `${users.length} perfiles disponibles en toda la red CONIG. Las primeras sugerencias priorizan amigos de amigos.`;
    }

    if (!users.length) {
      message.textContent = "Todavía no hay otros usuarios registrados en CONIG.";
      return;
    }

    renderNextPage();
  } catch (error) {
    message.textContent = error.message;
  }
});
