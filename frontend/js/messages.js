document.addEventListener("DOMContentLoaded", async () => {
  if (!ConigAPI.requireAuth()) return;

  const list = document.getElementById("conversationList");
  const followingList = document.getElementById("followingList");
  const history = document.getElementById("messageHistory");
  const form = document.getElementById("messageForm");
  const chatTitle = document.getElementById("chatTitle");
  const notice = document.getElementById("conversationNotice");
  const chatActions = document.getElementById("chatActions");
  const showConversationsTab = document.getElementById("showConversationsTab");
  const showFollowingTab = document.getElementById("showFollowingTab");
  const navBadge = document.getElementById("messageNavBadge");
  const profilePromptModal = new bootstrap.Modal(document.getElementById("profilePromptModal"));
  const profilePromptName = document.getElementById("profilePromptName");
  const profilePromptUsername = document.getElementById("profilePromptUsername");
  const profilePromptConfirm = document.getElementById("profilePromptConfirm");
  const requestedUserId = new URLSearchParams(window.location.search).get("userId");
  let profileTarget = null;

  let activeConversation = null;
  let conversations = [];
  let followingUsers = [];
  let currentUser = null;
  let historyLoading = false;
  let polling = false;

  function node(tag, cls, text) {
    const element = document.createElement(tag);
    element.className = cls || "";
    if (text !== undefined) element.textContent = text;
    return element;
  }

  profilePromptConfirm.addEventListener("click", () => {
    if (!profileTarget || !profileTarget.userId) return;
    window.location.href = "perfil.html?userId=" + encodeURIComponent(profileTarget.userId);
  });

  function avatarFor(user, className) {
    if (user && user.avatarUrl) {
      const image = node("img", className);
      image.src = user.avatarUrl;
      image.alt = "Foto de " + (user.username || "perfil");
      image.loading = "lazy";
      return image;
    }
    return node("span", className + " conversation-avatar-placeholder",
      ((user && user.username) || "U").charAt(0).toUpperCase());
  }

  function profileAvatarFor(user, className) {
    const avatar = avatarFor(user, className);
    if (!user || !user.userId) return avatar;

    avatar.classList.add("conversation-avatar-profile");
    avatar.title = "Ver perfil";
    avatar.setAttribute("role", "button");
    avatar.setAttribute("tabindex", "0");

    function openProfile(event) {
      event.preventDefault();
      event.stopPropagation();
      profileTarget = user;
      profilePromptName.textContent = user.displayName || user.username || "Usuario";
      profilePromptUsername.textContent = user.username ? "@" + user.username : "";
      profilePromptModal.show();
    }

    avatar.addEventListener("click", openProfile);
    avatar.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        openProfile(event);
      }
    });
    return avatar;
  }

  function updateBadge() {
    const total = conversations.reduce((sum, item) => {
      const unread = Number(item.unreadCount) || 0;
      const incomingRequest = item.status === "pending" && item.requestedBy !== currentUser.id;
      return sum + (unread > 0 ? unread : (incomingRequest ? 1 : 0));
    }, 0);
    if (!navBadge) return;
    navBadge.textContent = total > 99 ? "99+" : String(total);
    navBadge.classList.toggle("d-none", total < 1);
  }

  function renderConversationList() {
    list.replaceChildren();
    if (activeConversation && !activeConversation.conversationId) {
      const pending = node("button", "conversation-entry active", "");
      pending.type = "button";
      const row = node("span", "conversation-entry-row");
      row.append(profileAvatarFor(activeConversation.participant, "conversation-avatar"));
      const identity = node("span", "conversation-entry-identity");
      identity.append(node("strong", "", "Nueva conversación"));
      identity.append(node("small", "text-secondary", "@" + activeConversation.participant.username));
      row.append(identity);
      pending.append(row);
      pending.addEventListener("click", () => loadHistory(false));
      list.append(pending);
    }

    if (!conversations.length && !activeConversation) {
      list.append(node("p", "text-secondary small mb-0", "Todavía no tienes conversaciones."));
      return;
    }

    conversations.forEach(conversation => {
      if (!conversation.participant) return;
      const button = node("button", "conversation-entry", "");
      button.type = "button";
      if (activeConversation && activeConversation.conversationId === conversation.conversationId) {
        button.classList.add("active");
      }
      const row = node("span", "conversation-entry-row");
      row.append(profileAvatarFor(conversation.participant, "conversation-avatar"));
      const identity = node("span", "conversation-entry-identity");
      identity.append(node("strong", "", "@" + conversation.participant.username));
      let detail = conversation.lastMessage ? conversation.lastMessage.content : "Conversación";
      if (conversation.status === "pending") {
        detail = conversation.requestedBy === currentUser.id
          ? "Solicitud enviada · pendiente de aceptación"
          : "Solicitud de conversación pendiente";
      }
      identity.append(node("small", "text-secondary", detail));
      row.append(identity);
      if (conversation.unreadCount > 0) {
        row.append(node("span", "conversation-unread-count", String(conversation.unreadCount)));
      } else if (conversation.status === "pending" && conversation.requestedBy !== currentUser.id) {
        row.append(node("span", "conversation-request-dot", "!"));
      }
      button.append(row);
      button.addEventListener("click", async () => {
        activeConversation = conversation;
        renderConversationList();
        await loadHistory(false);
      });
      list.append(button);
    });
  }

  async function loadConversations(silent) {
    try {
      const data = await ConigAPI.request("/api/conversations");
      conversations = data.conversations || [];
      updateBadge();
      renderConversationList();
      return true;
    } catch (error) {
      if (!silent) list.textContent = error.message;
      return false;
    }
  }

  function renderNotice() {
    notice.replaceChildren();
    const isPending = activeConversation && activeConversation.status === "pending";
    if (isPending && activeConversation.requestedBy === currentUser.id) {
      notice.append(node("div", "alert alert-info py-2 small mb-0",
        "Solicitud enviada. Podrás continuar cuando la otra persona acepte la conversación."));
      form.querySelector("input[name=content]").disabled = false;
    } else if (isPending) {
      notice.append(node("div", "alert alert-warning py-2 small", "Esta persona quiere iniciar una conversación contigo."));
      const accept = node("button", "btn btn-success btn-sm", "Aceptar conversación");
      accept.type = "button";
      accept.addEventListener("click", async () => {
        accept.disabled = true;
        try {
          await ConigAPI.request("/api/conversations/" + encodeURIComponent(activeConversation.conversationId) + "/accept", { method: "PATCH" });
          await loadConversations(true);
          activeConversation = conversations.find(item => item.conversationId === activeConversation.conversationId) || activeConversation;
          await loadHistory(false);
          notice.append(node("div", "alert alert-success py-2 small mb-0 mt-2",
            "Conversación aceptada. Puedes seguir a esta persona desde su perfil cuando quieras."));
        } catch (error) {
          alert(error.message);
          accept.disabled = false;
        }
      });
      notice.append(accept);
      form.querySelector("input[name=content]").disabled = true;
    } else {
      form.querySelector("input[name=content]").disabled = !activeConversation;
    }
    chatActions.classList.toggle("d-none", !activeConversation || !activeConversation.conversationId);
  }

  function messageStatusInfo(status) {
    if (status === "read") {
      return { icon: "bi-check2-all", className: "message-status-read", label: "Leído" };
    }
    if (status === "delivered") {
      return { icon: "bi-check2-all", className: "message-status-delivered", label: "Entregado" };
    }
    return { icon: "bi-check2", className: "message-status-sent", label: "Enviado" };
  }

  async function markMessagesRead(messages) {
    if (document.visibilityState !== "visible") return;
    const unread = messages.filter(message =>
      message.senderId !== currentUser.id && message.deliveryStatus !== "read"
    );
    if (!unread.length) return;
    await Promise.all(unread.map(async message => {
      try {
        await ConigAPI.request("/api/messages/" + encodeURIComponent(message.messageId) + "/read", { method: "PATCH" });
        message.deliveryStatus = "read";
      } catch (error) {
        // Se reintentará automáticamente en la próxima actualización.
      }
    }));
  }

  async function loadHistory(silent) {
    if (historyLoading || !activeConversation || !activeConversation.participant) return;
    historyLoading = true;
    const wasNearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 90;
    const oldScrollTop = history.scrollTop;
    try {
      chatTitle.textContent = "Chat con @" + activeConversation.participant.username;
      renderNotice();
      if (!activeConversation.conversationId) {
        history.replaceChildren();
        history.append(node("p", "text-secondary text-center my-5", "Todavía no hay mensajes. ¡Escribe para iniciar la conversación!"));
        return;
      }

      if (!silent) history.textContent = "Cargando mensajes...";
      const id = encodeURIComponent(activeConversation.conversationId);
      const data = await ConigAPI.request("/api/conversations/" + id + "/messages");
      if (data.status) activeConversation.status = data.status;
      if (data.requestedBy) activeConversation.requestedBy = data.requestedBy;
      renderNotice();
      history.replaceChildren();

      if (!data.messages || !data.messages.length) {
        history.append(node("p", "text-secondary text-center my-5", "Todavía no hay mensajes. ¡Escribe para iniciar la conversación!"));
      } else {
        data.messages.forEach(message => {
          const mine = message.senderId === currentUser.id;
          const bubble = node("div", "message-bubble " + (mine ? "message-mine" : "message-other"), message.content);
          const metadata = node("div", "message-meta");
          if (mine) {
            const statusInfo = messageStatusInfo(message.deliveryStatus);
            const status = node("span", "message-status " + statusInfo.className);
            status.append(node("i", "bi " + statusInfo.icon));
            status.title = statusInfo.label;
            status.setAttribute("aria-label", statusInfo.label);
            metadata.append(status);
          }
          const date = node("small", "message-time", new Date(message.createdAt).toLocaleString("es-CO"));
          metadata.append(date);
          const wrapper = node("div", mine ? "message-row mine" : "message-row");
          wrapper.append(bubble, metadata);
          history.append(wrapper);
        });
        await markMessagesRead(data.messages);
      }

      if (wasNearBottom) history.scrollTop = history.scrollHeight;
      else history.scrollTop = oldScrollTop;
      if (!silent) {
        await loadConversations(true);
        const refreshed = conversations.find(item => item.conversationId === activeConversation.conversationId);
        if (refreshed) activeConversation = refreshed;
        renderNotice();
        renderConversationList();
      }
    } catch (error) {
      if (!silent) history.textContent = error.message;
    } finally {
      historyLoading = false;
    }
  }

  async function openRequestedConversation(userId) {
    if (!userId || userId === currentUser.id) return;
    try {
      const participant = await ConigAPI.request("/api/users/" + encodeURIComponent(userId));
      const existing = conversations.find(item => item.participant && item.participant.userId === userId);
      activeConversation = existing || {
        conversationId: null,
        status: "accepted",
        requestedBy: null,
        participant: {
          userId,
          username: participant.username,
          displayName: participant.displayName,
          avatarUrl: participant.avatarUrl,
          homeRegion: participant.homeRegion
        }
      };
      showListTab("conversations");
      renderConversationList();
      await loadHistory(false);
    } catch (error) {
      alert("No se pudo abrir el chat: " + error.message);
    }
  }

  async function loadFollowingUsers() {
    followingList.textContent = "Cargando personas que sigues...";
    try {
      const result = await ConigAPI.request("/api/follows/following-users");
      followingUsers = result.users || [];
      followingList.replaceChildren();
      if (!followingUsers.length) {
        followingList.append(node("p", "text-secondary small mb-0", "Todavía no sigues a nadie. Sigue un perfil para poder iniciar una conversación."));
        return;
      }
      if (result.partial) {
        followingList.append(node("p", "text-secondary small", "Se muestran los perfiles disponibles; una región no respondió."));
      }
      followingUsers.forEach(person => {
        const button = node("button", "conversation-entry", "");
        button.type = "button";
        const row = node("span", "conversation-entry-row");
        row.append(profileAvatarFor(person, "conversation-avatar"));
        const identity = node("span", "conversation-entry-identity");
        identity.append(node("strong", "", person.displayName || person.username));
        identity.append(node("small", "text-secondary", "@" + person.username));
        row.append(identity);
        row.append(node("span", "text-primary small ms-auto", "Iniciar"));
        button.append(row);
        button.addEventListener("click", () => openRequestedConversation(person.userId));
        followingList.append(button);
      });
    } catch (error) {
      followingList.textContent = error.message;
    }
  }

  function showListTab(tab) {
    const following = tab === "following";
    list.classList.toggle("d-none", following);
    followingList.classList.toggle("d-none", !following);
    showConversationsTab.classList.toggle("btn-primary", !following);
    showConversationsTab.classList.toggle("btn-outline-primary", following);
    showFollowingTab.classList.toggle("btn-primary", following);
    showFollowingTab.classList.toggle("btn-outline-primary", !following);
    if (following && !followingUsers.length) loadFollowingUsers();
  }

  showConversationsTab.addEventListener("click", () => showListTab("conversations"));
  showFollowingTab.addEventListener("click", () => showListTab("following"));

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!activeConversation || !activeConversation.participant || !activeConversation.participant.userId) {
      return alert("Selecciona una conversación o inicia un chat con alguien que sigues.");
    }
    if (activeConversation.status === "pending" && activeConversation.requestedBy !== currentUser.id) {
      return alert("Primero debes aceptar la solicitud de conversación.");
    }
    const content = form.elements.content.value.trim();
    if (!content) return;
    const sendButton = form.querySelector("button[type=submit]");
    sendButton.disabled = true;
    try {
      const recipientId = activeConversation.participant.userId;
      const result = await ConigAPI.request("/api/messages/" + encodeURIComponent(recipientId), {
        method: "POST",
        data: { content }
      });
      form.reset();
      await loadConversations(true);
      activeConversation = conversations.find(item => item.participant && item.participant.userId === recipientId) || {
        conversationId: result.data.conversationId,
        status: result.data.status,
        requestedBy: result.data.requestedBy,
        participant: activeConversation.participant
      };
      renderConversationList();
      await loadHistory(false);
    } catch (error) {
      alert(error.message);
    } finally {
      sendButton.disabled = false;
    }
  });

  document.getElementById("deleteChatButton").addEventListener("click", async () => {
    if (!activeConversation || !activeConversation.conversationId) return;
    if (!confirm("¿Quieres borrar este chat?")) return;
    const deleteButton = document.getElementById("deleteChatButton");
    deleteButton.disabled = true;
    try {
      await ConigAPI.request("/api/conversations/" + encodeURIComponent(activeConversation.conversationId), { method: "DELETE" });
      activeConversation = null;
      history.replaceChildren();
      history.append(node("p", "text-secondary text-center my-5", "Selecciona una conversación para ver los mensajes."));
      chatTitle.textContent = "Chat";
      notice.replaceChildren();
      chatActions.classList.add("d-none");
      form.elements.content.disabled = true;
      await loadConversations(true);
      renderConversationList();
    } catch (error) {
      alert(error.message);
    } finally {
      deleteButton.disabled = false;
    }
  });

  async function pollMessages() {
    if (polling || document.visibilityState !== "visible") return;
    polling = true;
    try {
      await loadConversations(true);
      if (activeConversation && activeConversation.conversationId) {
        const refreshed = conversations.find(item => item.conversationId === activeConversation.conversationId);
        if (refreshed) activeConversation = refreshed;
        else {
          activeConversation = null;
          chatTitle.textContent = "Chat";
          notice.replaceChildren();
          chatActions.classList.add("d-none");
          form.elements.content.disabled = true;
          history.replaceChildren();
          history.append(node("p", "text-secondary text-center my-5", "Esta conversación ya no está disponible en tu lista."));
        }
        if (activeConversation) await loadHistory(true);
      }
    } finally {
      polling = false;
    }
  }

  try {
    currentUser = await ConigAPI.request("/api/me");
    const adminNavLink = document.getElementById("adminNavLink");
    if (adminNavLink) adminNavLink.classList.toggle("d-none", currentUser.isAdmin !== true);
    form.elements.content.disabled = true;
    await loadConversations(false);
    if (requestedUserId) await openRequestedConversation(requestedUserId);
    window.setInterval(pollMessages, 1500);
  } catch (error) {
    history.textContent = error.message;
  }
});
