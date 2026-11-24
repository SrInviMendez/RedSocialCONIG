document.addEventListener("DOMContentLoaded", async () => {
  if (!ConigAPI.requireAuth()) return;

  const recommendations = document.getElementById("recommendations");
  const recommendationsMore = document.getElementById("recommendationsMore");
  const profilePosts = document.getElementById("profilePosts");
  const followProfileButton = document.getElementById("followProfileButton");
  const params = new URLSearchParams(window.location.search);
  const requestedUserId = params.get("userId");
  let recommendationUsers = [];
  let showAllRecommendations = false;
  let viewedProfile = null;
  let isOwnProfile = true;

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function setAvatar(imageElement, placeholderElement, avatarUrl, altText) {
    if (avatarUrl) {
      imageElement.src = avatarUrl;
      imageElement.alt = altText;
      imageElement.classList.remove("d-none");
      placeholderElement.classList.add("d-none");
    } else {
      imageElement.classList.add("d-none");
      placeholderElement.classList.remove("d-none");
    }
  }

  async function changeFollow(user, button, afterChange) {
    button.disabled = true;
    try {
      await ConigAPI.request(`/api/follows/${encodeURIComponent(user.userId)}`, {
        method: user.isFollowing ? "DELETE" : "POST"
      });
      user.isFollowing = !user.isFollowing;
      button.textContent = user.isFollowing ? "Siguiendo" : "Seguir";
      button.classList.toggle("btn-primary", !user.isFollowing);
      button.classList.toggle("btn-outline-secondary", user.isFollowing);
      if (afterChange) afterChange(user);
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function renderRecommendations() {
    recommendations.replaceChildren();
    if (!recommendationUsers.length) {
      recommendations.textContent = "Todavía no hay otros perfiles registrados en CONIG.";
      recommendationsMore.classList.add("d-none");
      return;
    }

    const visibleUsers = showAllRecommendations
      ? recommendationUsers
      : recommendationUsers.slice(0, 4);

    visibleUsers.forEach(person => {
      const item = node("div", "recommendation-item d-flex align-items-center gap-3 flex-wrap");
      const link = node("a", "d-flex align-items-center gap-3 text-decoration-none text-reset flex-grow-1");
      link.href = `perfil.html?userId=${encodeURIComponent(person.userId)}`;

      if (person.avatarUrl) {
        const avatar = node("img", "recommendation-avatar");
        avatar.src = person.avatarUrl;
        avatar.alt = `Foto de ${person.username}`;
        avatar.loading = "lazy";
        link.append(avatar);
      } else {
        link.append(node("span", "recommendation-avatar recommendation-avatar-placeholder",
          (person.username || "U").charAt(0).toUpperCase()));
      }

      const identity = node("span", "d-flex flex-column");
      identity.append(node("strong", "", person.displayName || person.username));
      identity.append(node("small", "text-secondary", `@${person.username}`));
      const detail = person.commonConnectionsCount > 0
        ? `${person.commonConnectionsCount} conexiones en común`
        : (person.bio || "Perfil de la comunidad CONIG");
      identity.append(node("small", "text-secondary", detail));
      link.append(identity);

      const button = node("button", `btn btn-sm ${person.isFollowing ? "btn-outline-secondary" : "btn-primary"}`,
        person.isFollowing ? "Siguiendo" : "Seguir");
      button.type = "button";
      button.addEventListener("click", () => changeFollow(person, button));
      item.append(link, button);
      recommendations.append(item);
    });

    recommendationsMore.classList.toggle("d-none", recommendationUsers.length <= 4);
    recommendationsMore.textContent = showAllRecommendations ? "Ver menos" : "Ver más";
  }

  async function loadProfilePosts(profileId) {
    profilePosts.textContent = "Cargando publicaciones...";
    profilePosts.replaceChildren();
    try {
      const result = await ConigAPI.request(`/api/users/${encodeURIComponent(profileId)}/posts`);
      if (!result.posts || !result.posts.length) {
        profilePosts.textContent = "Esta persona todavía no ha publicado nada.";
        return;
      }

      result.posts.forEach(post => {
        const card = node("article", "profile-post-card mb-3");
        card.append(node("p", "post-content mb-2", post.content));
        if (post.imageUrl) {
          const image = node("img", "profile-post-image");
          image.src = post.imageUrl;
          image.alt = "Imagen de la publicación";
          image.loading = "lazy";
          card.append(image);
        }
        const footer = node("div", "d-flex justify-content-between align-items-center mt-3");
        footer.append(
          node("small", "text-secondary", new Date(post.createdAt).toLocaleString("es-CO")),
          node("small", "text-secondary", `${Number(post.likeCount) || 0} Me gusta`)
        );
        card.append(footer);
        profilePosts.append(card);
      });
    } catch (error) {
      profilePosts.textContent = error.message;
    }
  }

  try {
    const currentUser = await ConigAPI.request("/api/me");
    isOwnProfile = !requestedUserId || requestedUserId === currentUser.id;
    viewedProfile = isOwnProfile
      ? currentUser
      : await ConigAPI.request(`/api/users/${encodeURIComponent(requestedUserId)}`);

    const profileId = viewedProfile.id || viewedProfile.userId;
    document.getElementById("profilePageTitle").textContent = isOwnProfile ? "Mi perfil" : "Perfil de usuario";
    document.getElementById("profileName").textContent = viewedProfile.displayName || viewedProfile.username;
    document.getElementById("profileUsername").textContent = `@${viewedProfile.username}`;
    document.getElementById("profileBio").textContent = viewedProfile.bio || "Sin biografía";
    document.getElementById("profilePostsTitle").textContent = isOwnProfile
      ? "Mis publicaciones"
      : `Publicaciones de @${viewedProfile.username}`;

    const avatar = document.getElementById("profileAvatar");
    const placeholder = document.getElementById("avatarPlaceholder");
    setAvatar(avatar, placeholder, viewedProfile.avatarUrl, `Fotografía de ${viewedProfile.username}`);

    if (isOwnProfile) {
      const follows = await ConigAPI.request("/api/follows");
      document.getElementById("followersCount").textContent = follows.followersCount;
      document.getElementById("followingCount").textContent = follows.followingCount;
      document.getElementById("recommendationsCard").classList.remove("d-none");

      const suggested = await ConigAPI.request("/api/recommendations");
      recommendationUsers = suggested.recommendations || [];
      renderRecommendations();
    } else {
      document.getElementById("followersCount").textContent = viewedProfile.followersCount || 0;
      document.getElementById("followingCount").textContent = viewedProfile.followingCount || 0;
      document.getElementById("recommendationsCard").classList.add("d-none");

      const profileFollow = {
        userId: profileId,
        isFollowing: Boolean(viewedProfile.isFollowing)
      };
      followProfileButton.classList.remove("d-none");
      followProfileButton.textContent = profileFollow.isFollowing ? "Siguiendo" : "Seguir";
      followProfileButton.classList.toggle("btn-primary", !profileFollow.isFollowing);
      followProfileButton.classList.toggle("btn-outline-secondary", profileFollow.isFollowing);
      followProfileButton.addEventListener("click", () => changeFollow(
        profileFollow,
        followProfileButton,
        updated => {
          viewedProfile.isFollowing = updated.isFollowing;
          const count = document.getElementById("followersCount");
          count.textContent = Math.max(0, Number(count.textContent) + (updated.isFollowing ? 1 : -1));
        }
      ));
    }

    recommendationsMore.addEventListener("click", () => {
      showAllRecommendations = !showAllRecommendations;
      renderRecommendations();
    });

    await loadProfilePosts(profileId);
  } catch (error) {
    document.getElementById("profileName").textContent = "No se pudo cargar el perfil";
    profilePosts.textContent = error.message;
  }
});
