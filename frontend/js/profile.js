document.addEventListener("DOMContentLoaded", async () => {
  if (!ConigAPI.requireAuth()) return;

  const recommendations = document.getElementById("recommendations");

  try {
    const [user, follows, suggested] = await Promise.all([
      ConigAPI.request("/api/me"),
      ConigAPI.request("/api/follows"),
      ConigAPI.request("/api/recommendations")
    ]);

    document.getElementById("profileName").textContent =
      user.displayName || user.username;

    document.getElementById("profileUsername").textContent =
      `@${user.username}`;

    document.getElementById("profileBio").textContent =
      user.bio || "Sin biografía";

    document.getElementById("followersCount").textContent = follows.followersCount;
    document.getElementById("followingCount").textContent = follows.followingCount;

    const avatar = document.getElementById("profileAvatar");

    if (user.avatarUrl) {
      avatar.src = user.avatarUrl;
      avatar.classList.remove("d-none");
      document.getElementById("avatarPlaceholder").classList.add("d-none");
    }

    if (!suggested.recommendations.length) {
      recommendations.textContent =
        "Todavía no hay recomendaciones. Necesitas conexiones de segundo grado.";
      return;
    }

    recommendations.replaceChildren();

    suggested.recommendations.forEach(person => {
      const item = document.createElement("div");
      item.className = "recommendation-item";

      const title = document.createElement("strong");
      title.textContent = person.displayName || person.username;

      const username = document.createElement("div");
      username.className = "text-secondary small";
      username.textContent = `@${person.username}`;

      const mutual = document.createElement("div");
      mutual.className = "small";
      mutual.textContent = `${person.commonConnectionsCount} conexiones en común`;

      const button = document.createElement("button");
      button.className = "btn btn-sm btn-outline-primary mt-2";
      button.textContent = "Seguir";

      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await ConigAPI.request(`/api/follows/${person.userId}`, {
            method: "POST"
          });
          item.remove();
        } catch (error) {
          alert(error.message);
          button.disabled = false;
        }
      });

      item.append(title, username, mutual, button);
      recommendations.append(item);
    });

  } catch (error) {
    recommendations.textContent = error.message;
  }
});