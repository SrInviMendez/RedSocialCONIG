document.addEventListener("DOMContentLoaded", async () => {
  if (!ConigAPI.requireAuth()) return;

  const postsContainer = document.getElementById("postsContainer");
  const feedMessage = document.getElementById("feedMessage");
  const postForm = document.getElementById("postForm");
  const contentInput = document.getElementById("postContent");
  const charCount = document.getElementById("postCharCount");
  const imageInput = document.getElementById("postImageInput");
  const imagePreviewContainer = document.getElementById("postImagePreviewContainer");
  const imagePreview = document.getElementById("postImagePreview");
  const imageName = document.getElementById("postImageName");
  const removeImageButton = document.getElementById("removePostImage");
  const directoryPreview = document.getElementById("directoryPreview");
  const directoryPreviewMessage = document.getElementById("directoryPreviewMessage");

  let previewUrl = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function updateCharacterCount() {
    const length = contentInput.value.length;
    charCount.textContent = `${length} / 280 caracteres`;
    charCount.classList.toggle("text-danger", length >= 260);
    charCount.classList.toggle("text-secondary", length < 260);
  }

  function clearImagePreview() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    imageInput.value = "";
    imagePreview.removeAttribute("src");
    imagePreviewContainer.classList.add("d-none");
    imageName.textContent = "Ninguna imagen seleccionada";
  }

  contentInput.addEventListener("input", updateCharacterCount);
  updateCharacterCount();

  imageInput.addEventListener("change", () => {
    const file = imageInput.files[0];
    if (!file) {
      clearImagePreview();
      return;
    }

    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      alert("Selecciona una imagen JPEG, PNG o WebP.");
      clearImagePreview();
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      alert("La imagen no puede superar los 5 MB.");
      clearImagePreview();
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    imagePreview.src = previewUrl;
    imagePreviewContainer.classList.remove("d-none");
    imageName.textContent = file.name;
  });

  removeImageButton.addEventListener("click", clearImagePreview);

  async function toggleFollow(user, button, onChange) {
    button.disabled = true;
    try {
      await ConigAPI.request(`/api/follows/${encodeURIComponent(user.userId)}`, {
        method: user.isFollowing ? "DELETE" : "POST"
      });
      user.isFollowing = !user.isFollowing;
      button.textContent = user.isFollowing ? "Siguiendo" : "Seguir";
      button.classList.toggle("btn-primary", !user.isFollowing);
      button.classList.toggle("btn-outline-secondary", user.isFollowing);
      if (onChange) onChange(user);
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function loadDirectoryPreview() {
    if (!directoryPreview || !directoryPreviewMessage) return;

    directoryPreview.replaceChildren();
    directoryPreviewMessage.textContent = "Cargando usuarios...";

    try {
      const result = await ConigAPI.request("/api/users");
      const users = (result.users || []).slice(0, 5);

      if (!users.length) {
        directoryPreviewMessage.textContent = "Todavía no hay otros perfiles registrados.";
        return;
      }

      directoryPreviewMessage.textContent = result.partial
        ? "Mostrando los perfiles disponibles; el otro nodo no respondió."
        : `${result.total} perfiles disponibles en la red.`;

      users.forEach(user => {
        const row = element("div", "directory-preview-item");
        const link = element("a", "directory-preview-link");
        link.href = `perfil.html?userId=${encodeURIComponent(user.userId)}`;

        if (user.avatarUrl) {
          const avatar = element("img", "directory-preview-avatar");
          avatar.src = user.avatarUrl;
          avatar.alt = `Foto de ${user.username}`;
          avatar.loading = "lazy";
          link.append(avatar);
        } else {
          link.append(element("span", "directory-preview-avatar directory-preview-placeholder",
            (user.username || "U").charAt(0).toUpperCase()));
        }

        const identity = element("span", "directory-preview-identity");
        identity.append(element("strong", "small text-truncate", user.displayName || user.username));
        identity.append(element("small", "text-secondary", `@${user.username}`));
        link.append(identity);

        const button = element("button", `btn btn-sm ${user.isFollowing ? "btn-outline-secondary" : "btn-primary"}`,
          user.isFollowing ? "Siguiendo" : "Seguir");
        button.type = "button";
        button.addEventListener("click", () => toggleFollow(user, button));

        row.append(link, button);
        directoryPreview.append(row);
      });
    } catch (error) {
      directoryPreviewMessage.textContent = error.message;
    }
  }

  async function loadPosts() {
    postsContainer.replaceChildren();
    feedMessage.textContent = "Cargando publicaciones...";

    try {
      const result = await ConigAPI.request("/api/posts");
      feedMessage.textContent = `${result.total} publicaciones en tu comunidad`;

      if (!result.posts.length) {
        postsContainer.append(element("div", "alert alert-light", "Todavía no hay publicaciones."));
        return;
      }

      result.posts.forEach(post => {
        const card = element("article", "card post-card mb-3");
        const body = element("div", "card-body");
        const header = element("div", "d-flex align-items-center gap-2 mb-3");
        const author = post.author || {};
        const authorId = author.userId || post.authorId;
        const authorName = author.username ? `@${author.username}` : "Usuario";
        const profileLink = element("a", "post-author-link d-flex align-items-center gap-2 text-decoration-none");
        if (authorId) profileLink.href = `perfil.html?userId=${encodeURIComponent(authorId)}`;

        if (author.avatarUrl) {
          const avatar = element("img", "post-author-avatar");
          avatar.src = author.avatarUrl;
          avatar.alt = `Foto de perfil de ${authorName}`;
          avatar.loading = "lazy";
          profileLink.append(avatar);
        } else {
          profileLink.append(element("span", "post-author-avatar post-author-placeholder",
            authorName.charAt(1).toUpperCase() || "U"));
        }

        const identity = element("span", "d-flex flex-column");
        identity.append(element("strong", "post-author-username", authorName));
        if (author.displayName) identity.append(element("small", "text-secondary", author.displayName));
        profileLink.append(identity);
        header.append(profileLink);
        body.append(header);
        body.append(element("p", "post-content mb-3", post.content));

        if (post.imageUrl) {
          const image = element("img", "post-image");
          image.src = post.imageUrl;
          image.alt = "Imagen de la publicación";
          image.loading = "lazy";
          body.append(image);
        }

        const footer = element("div", "d-flex justify-content-between align-items-center mt-3");
        const likeButton = element("button", `btn btn-sm ${post.likedByMe ? "btn-danger" : "btn-outline-danger"}`);
        likeButton.innerHTML = `<i class="bi bi-heart${post.likedByMe ? "-fill" : ""}"></i> ${Number(post.likeCount) || 0} Me gusta`;
        likeButton.addEventListener("click", async () => {
          likeButton.disabled = true;
          try {
            await ConigAPI.request(`/api/likes/${encodeURIComponent(post.postId)}`, {
              method: post.likedByMe ? "DELETE" : "POST"
            });
            await loadPosts();
          } catch (error) {
            alert(error.message);
            likeButton.disabled = false;
          }
        });

        footer.append(likeButton, element("small", "text-secondary",
          new Date(post.createdAt).toLocaleString("es-CO")));
        body.append(footer);
        card.append(body);
        postsContainer.append(card);
      });
    } catch (error) {
      feedMessage.textContent = error.message;
    }
  }

  postForm.addEventListener("submit", async event => {
    event.preventDefault();
    const content = contentInput.value.trim();
    const file = imageInput.files[0];

    if (!content || content.length > 280) {
      return alert("La publicación debe tener entre 1 y 280 caracteres.");
    }
    if (file && file.size > 5 * 1024 * 1024) {
      return alert("La imagen no puede superar los 5 MB.");
    }

    const button = postForm.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const form = new FormData();
      form.append("content", content);
      if (file) form.append("image", file);
      await ConigAPI.request("/api/posts", { method: "POST", data: form });
      postForm.reset();
      clearImagePreview();
      updateCharacterCount();
      await loadPosts();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("refreshFeed").addEventListener("click", loadPosts);

  try {
    const user = await ConigAPI.request("/api/me");
    document.getElementById("welcomeName").textContent = user.displayName || user.username;
  } catch {
    sessionStorage.clear();
    window.location.href = "login.html";
    return;
  }

  loadPosts();
  loadDirectoryPreview();
});
