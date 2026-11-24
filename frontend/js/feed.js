document.addEventListener("DOMContentLoaded", async () => {
  if (!ConigAPI.requireAuth()) return;

  const postsContainer = document.getElementById("postsContainer");
  const feedMessage = document.getElementById("feedMessage");
  const postForm = document.getElementById("postForm");

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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

        const header = element("div", "d-flex justify-content-between align-items-center mb-3");
        const author = element("div", "fw-semibold",
          `Usuario ${String(post.authorId).slice(-6)}`);
        header.append(author);
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
        const likeButton = element("button",
          `btn btn-sm ${post.likedByMe ? "btn-danger" : "btn-outline-danger"}`);

        likeButton.innerHTML =
          `<i class="bi bi-heart${post.likedByMe ? "-fill" : ""}"></i> ${Number(post.likeCount) || 0} Me gusta`;

        likeButton.addEventListener("click", async () => {
          likeButton.disabled = true;

          try {
            await ConigAPI.request(
              `/api/likes/${encodeURIComponent(post.postId)}`,
              { method: post.likedByMe ? "DELETE" : "POST" }
            );

            await loadPosts();
          } catch (error) {
            alert(error.message);
            likeButton.disabled = false;
          }
        });

        footer.append(
          likeButton,
          element("small", "text-secondary",
            new Date(post.createdAt).toLocaleString("es-CO"))
        );

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

    const content = postForm.content.value.trim();
    const file = postForm.image.files[0];

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

      await ConigAPI.request("/api/posts", {
        method: "POST",
        data: form
      });

      postForm.reset();
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
    document.getElementById("welcomeName").textContent =
      user.displayName || user.username;
  } catch {
    sessionStorage.clear();
    window.location.href = "login.html";
    return;
  }

  loadPosts();
});