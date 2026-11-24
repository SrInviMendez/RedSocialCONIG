document.addEventListener("DOMContentLoaded", async () => {
  if (!ConigAPI.requireAuth()) return;

  const recommendations = document.getElementById("recommendations");
  const recommendationsMore = document.getElementById("recommendationsMore");
  const recommendationsAll = document.getElementById("recommendationsAll");
  const profilePosts = document.getElementById("profilePosts");
  const followProfileButton = document.getElementById("followProfileButton");
  const messageProfileButton = document.getElementById("messageProfileButton");
  const editProfileButton = document.getElementById("editProfileButton");
  const editProfileForm = document.getElementById("editProfileForm");
  const editProfileMessage = document.getElementById("editProfileMessage");
  const editAvatarInput = document.getElementById("editAvatar");
  const editAvatarPreview = document.getElementById("editAvatarPreview");
  const editAvatarPreviewContainer = document.getElementById("editAvatarPreviewContainer");
  const editProfileModal = new bootstrap.Modal(document.getElementById("editProfileModal"));
  const deletePostModal = new bootstrap.Modal(document.getElementById("deletePostModal"));
  const deletePostMessage = document.getElementById("deletePostMessage");
  const confirmDeletePostButton = document.getElementById("confirmDeletePostButton");
  const params = new URLSearchParams(window.location.search);
  const requestedUserId = params.get("userId");
  let recommendationUsers = [];
  let showExpandedRecommendations = false;
  let viewedProfile = null;
  let previewUrl = null;
  let currentUserId = null;
  let activeProfileId = null;
  let canManageOwnPosts = false;
  let selectedPostForDelete = null;

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

  function updateFollowButton(user, button) {
    button.textContent = user.isFollowing ? "Siguiendo" : "Seguir";
    button.classList.toggle("btn-primary", !user.isFollowing);
    button.classList.toggle("btn-outline-secondary", user.isFollowing);
  }

  async function changeFollow(user, button, afterChange) {
    button.disabled = true;
    try {
      await ConigAPI.request("/api/follows/" + encodeURIComponent(user.userId), {
        method: user.isFollowing ? "DELETE" : "POST"
      });
      user.isFollowing = !user.isFollowing;
      updateFollowButton(user, button);
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
      recommendations.textContent = "No hay perfiles nuevos para recomendarte por ahora.";
      recommendationsMore.classList.add("d-none");
      recommendationsAll.classList.add("d-none");
      return;
    }

    const visibleUsers = recommendationUsers.slice(0, showExpandedRecommendations ? 8 : 4);
    visibleUsers.forEach(person => {
      const column = node("div", "col-6 col-lg-3");
      const card = node("article", "card profile-recommendation-card h-100");
      const body = node("div", "card-body d-flex flex-column align-items-center text-center");
      const link = node("a", "profile-recommendation-link text-decoration-none text-reset");
      link.href = "perfil.html?userId=" + encodeURIComponent(person.userId);

      if (person.avatarUrl) {
        const avatar = node("img", "profile-recommendation-avatar");
        avatar.src = person.avatarUrl;
        avatar.alt = "Foto de " + person.username;
        avatar.loading = "lazy";
        link.append(avatar);
      } else {
        link.append(node("span", "profile-recommendation-avatar profile-recommendation-placeholder",
          (person.username || "U").charAt(0).toUpperCase()));
      }

      link.append(node("strong", "d-block mt-2", person.displayName || person.username));
      link.append(node("small", "text-secondary d-block", "@" + person.username));
      body.append(link);
      const description = person.commonConnectionsCount > 0
        ? person.commonConnectionsCount + " conexiones en común"
        : (person.bio || "Perfil de la comunidad CONIG");
      body.append(node("p", "profile-recommendation-bio text-secondary small mt-2 mb-3", description));

      const button = node("button", "btn btn-sm btn-primary mt-auto", "Seguir");
      button.type = "button";
      button.addEventListener("click", () => changeFollow(person, button, () => {
        recommendationUsers = recommendationUsers.filter(item => item.userId !== person.userId);
        renderRecommendations();
      }));
      body.append(button);
      card.append(body);
      column.append(card);
      recommendations.append(column);
    });

    recommendationsMore.classList.toggle("d-none", recommendationUsers.length <= 4);
    recommendationsMore.textContent = showExpandedRecommendations ? "Ver menos" : "Ver más";
    recommendationsAll.classList.toggle("d-none", recommendationUsers.length <= 4);
  }

  async function loadProfilePosts(profileId) {
    profilePosts.textContent = "Cargando publicaciones...";
    profilePosts.replaceChildren();
    try {
      const result = await ConigAPI.request("/api/users/" + encodeURIComponent(profileId) + "/posts");
      if (!result.posts || !result.posts.length) {
        profilePosts.textContent = "Esta persona todavía no ha publicado nada.";
        return;
      }

      result.posts.forEach(post => {
        const card = node("article", "profile-post-card mb-3");
        const postCreatedAt = new Date(post.createdAt);
        const postAge = Date.now() - postCreatedAt.getTime();

        if (
          canManageOwnPosts &&
          post.authorId === currentUserId &&
          Number.isFinite(postAge) &&
          postAge >= 0 &&
          postAge <= 60 * 60 * 1000
        ) {
          const actions = node("div", "profile-post-actions d-flex justify-content-end mb-2");
          const dropdown = node("div", "dropdown");
          const menuButton = node("button", "btn btn-sm btn-light text-secondary", "");
          menuButton.type = "button";
          menuButton.setAttribute("data-bs-toggle", "dropdown");
          menuButton.setAttribute("aria-expanded", "false");
          menuButton.setAttribute("aria-label", "Opciones de publicación");
          menuButton.innerHTML = '<i class="bi bi-three-dots"></i>';

          const menu = node("ul", "dropdown-menu dropdown-menu-end");
          const item = node("li", "");
          const deleteButton = node("button", "dropdown-item text-danger", "Borrar publicación");
          deleteButton.type = "button";
          deleteButton.addEventListener("click", () => {
            selectedPostForDelete = post;
            deletePostMessage.textContent = "";
            deletePostModal.show();
          });
          item.append(deleteButton);
          menu.append(item);
          dropdown.append(menuButton, menu);
          actions.append(dropdown);
          card.append(actions);
        }

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
          node("small", "text-secondary", (Number(post.likeCount) || 0) + " Me gusta")
        );
        card.append(footer);
        profilePosts.append(card);
      });
    } catch (error) {
      profilePosts.textContent = error.message;
    }
  }

  confirmDeletePostButton.addEventListener("click", async () => {
    if (!selectedPostForDelete) return;
    const post = selectedPostForDelete;
    confirmDeletePostButton.disabled = true;
    deletePostMessage.className = "small text-secondary";
    deletePostMessage.textContent = "Eliminando publicación...";

    try {
      await ConigAPI.request("/api/posts/" + encodeURIComponent(post.postId), {
        method: "DELETE"
      });
      selectedPostForDelete = null;
      deletePostModal.hide();
      await loadProfilePosts(activeProfileId);
    } catch (error) {
      deletePostMessage.className = "small text-danger";
      deletePostMessage.textContent = error.message;
    } finally {
      confirmDeletePostButton.disabled = false;
    }
  });

  function showAvatarPreview(file) {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    if (!file) {
      editAvatarPreview.removeAttribute("src");
      editAvatarPreviewContainer.classList.add("d-none");
      return;
    }
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type) || file.size > 5 * 1024 * 1024) {
      alert("Selecciona una imagen JPEG, PNG o WebP de máximo 5 MB.");
      editAvatarInput.value = "";
      editAvatarPreview.removeAttribute("src");
      editAvatarPreviewContainer.classList.add("d-none");
      return;
    }
    previewUrl = URL.createObjectURL(file);
    editAvatarPreview.src = previewUrl;
    editAvatarPreviewContainer.classList.remove("d-none");
  }

  editAvatarInput.addEventListener("change", () => showAvatarPreview(editAvatarInput.files[0]));

  editProfileButton.addEventListener("click", () => {
    editProfileForm.elements.displayName.value = viewedProfile.displayName || "";
    editProfileForm.elements.bio.value = viewedProfile.bio || "";
    editAvatarInput.value = "";
    editProfileMessage.textContent = "";
    showAvatarPreview(null);
    editProfileModal.show();
  });

  editProfileForm.addEventListener("submit", async event => {
    event.preventDefault();
    const saveButton = document.getElementById("saveProfileButton");
    const file = editAvatarInput.files[0];
    if (file && file.size > 5 * 1024 * 1024) {
      editProfileMessage.textContent = "La fotografía no puede superar los 5 MB.";
      return;
    }

    saveButton.disabled = true;
    editProfileMessage.classList.remove("text-danger");
    editProfileMessage.classList.add("text-secondary");
    editProfileMessage.textContent = "Guardando cambios...";
    try {
      const formData = new FormData(editProfileForm);
      const result = await ConigAPI.request("/api/me", {
        method: "PATCH",
        data: formData,
        timeoutMs: 120000
      });
      viewedProfile = { ...viewedProfile, ...result.user };
      document.getElementById("profileName").textContent = viewedProfile.displayName || viewedProfile.username;
      document.getElementById("profileBio").textContent = viewedProfile.bio || "Sin biografía";
      const avatar = document.getElementById("profileAvatar");
      const placeholder = document.getElementById("avatarPlaceholder");
      setAvatar(avatar, placeholder, viewedProfile.avatarUrl, "Fotografía de " + viewedProfile.username);
      editProfileModal.hide();
    } catch (error) {
      editProfileMessage.classList.remove("text-secondary");
      editProfileMessage.classList.add("text-danger");
      editProfileMessage.textContent = error.message;
    } finally {
      saveButton.disabled = false;
    }
  });

  try {
    const currentUser = await ConigAPI.request("/api/me");
    const isOwnProfile = !requestedUserId || requestedUserId === currentUser.id;
    viewedProfile = isOwnProfile
      ? currentUser
      : await ConigAPI.request("/api/users/" + encodeURIComponent(requestedUserId));

    const profileId = viewedProfile.id || viewedProfile.userId;
    currentUserId = currentUser.id;
    activeProfileId = profileId;
    canManageOwnPosts = isOwnProfile;
    document.getElementById("profilePageTitle").textContent = isOwnProfile ? "Mi perfil" : "Perfil de usuario";
    document.getElementById("profileName").textContent = viewedProfile.displayName || viewedProfile.username;
    document.getElementById("profileUsername").textContent = "@" + viewedProfile.username;
    document.getElementById("profileBio").textContent = viewedProfile.bio || "Sin biografía";
    document.getElementById("profilePostsTitle").textContent = isOwnProfile
      ? "Mis publicaciones"
      : "Publicaciones de @" + viewedProfile.username;

    const avatar = document.getElementById("profileAvatar");
    const placeholder = document.getElementById("avatarPlaceholder");
    setAvatar(avatar, placeholder, viewedProfile.avatarUrl, "Fotografía de " + viewedProfile.username);

    if (isOwnProfile) {
      editProfileButton.classList.remove("d-none");
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

      messageProfileButton.href = "mensajes.html?userId=" + encodeURIComponent(profileId);
      messageProfileButton.classList.remove("d-none");

      const profileFollow = {
        userId: profileId,
        isFollowing: Boolean(viewedProfile.isFollowing)
      };
      followProfileButton.classList.remove("d-none");
      updateFollowButton(profileFollow, followProfileButton);
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
      showExpandedRecommendations = !showExpandedRecommendations;
      renderRecommendations();
    });

    await loadProfilePosts(profileId);
  } catch (error) {
    document.getElementById("profileName").textContent = "No se pudo cargar el perfil";
    profilePosts.textContent = error.message;
  }
});
