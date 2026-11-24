document.addEventListener("DOMContentLoaded", async () => {
  if (!ConigAPI.requireAuth()) return;

  const list = document.getElementById("conversationList");
  const history = document.getElementById("messageHistory");
  const form = document.getElementById("messageForm");
  const chatTitle = document.getElementById("chatTitle");
  const requestedUserId = new URLSearchParams(window.location.search).get("userId");

  let activeConversation = null;
  let conversations = [];
  let currentUser = null;

  function node(tag, cls, text) {
    const element = document.createElement(tag);
    element.className = cls || "";
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function renderConversationList() {
    list.replaceChildren();
    if (activeConversation && !activeConversation.conversationId) {
      const pending = node("button", "conversation-entry active", "Nueva conversación · @" + activeConversation.participant.username);
      pending.type = "button";
      pending.addEventListener("click", loadHistory);
      list.append(pending);
    }

    if (!conversations.length && !activeConversation) {
      list.textContent = "Todavía no tienes conversaciones.";
      return;
    }

    conversations.forEach(conversation => {
      if (!conversation.participant) return;
      const button = node("button", "conversation-entry", "@" + conversation.participant.username);
      button.type = "button";
      if (activeConversation?.conversationId === conversation.conversationId) {
        button.classList.add("active");
      }
      button.addEventListener("click", () => {
        activeConversation = conversation;
        loadHistory();
        renderConversationList();
      });
      list.append(button);
    });
  }

  async function loadConversations() {
    try {
      const data = await ConigAPI.request("/api/conversations");
      conversations = data.conversations || [];
      renderConversationList();
    } catch (error) {
      list.textContent = error.message;
      throw error;
    }
  }

  async function loadHistory() {
    if (!activeConversation?.participant?.userId) return;
    chatTitle.textContent = "Chat con @" + activeConversation.participant.username;

    if (!activeConversation.conversationId) {
      history.replaceChildren();
      history.append(node("p", "text-secondary text-center my-5", "Todavía no hay mensajes. ¡Escribe para iniciar la conversación!"));
      return;
    }

    history.textContent = "Cargando mensajes...";
    try {
      const id = encodeURIComponent(activeConversation.conversationId);
      const data = await ConigAPI.request("/api/conversations/" + id + "/messages");
      history.replaceChildren();

      if (!data.messages.length) {
        history.append(node("p", "text-secondary text-center my-5", "Todavía no hay mensajes. ¡Escribe para iniciar la conversación!"));
        return;
      }

      data.messages.forEach(message => {
        const mine = message.senderId === currentUser.id;
        const bubble = node(
          "div",
          "message-bubble " + (mine ? "message-mine" : "message-other"),
          message.content
        );
        const date = node("small", "text-secondary d-block mt-1",
          new Date(message.createdAt).toLocaleString("es-CO"));
        const wrapper = node("div", mine ? "message-row mine" : "message-row");
        wrapper.append(bubble, date);

        if (!mine && message.deliveryStatus !== "read") {
          const read = node("button", "btn btn-sm btn-link", "Marcar como leído");
          read.addEventListener("click", async () => {
            try {
              await ConigAPI.request("/api/messages/" + encodeURIComponent(message.messageId) + "/read", { method: "PATCH" });
              await loadHistory();
            } catch (error) {
              alert(error.message);
            }
          });
          wrapper.append(read);
        }
        history.append(wrapper);
      });
      history.scrollTop = history.scrollHeight;
    } catch (error) {
      history.textContent = error.message;
    }
  }

  async function openRequestedConversation(userId) {
    if (!userId || userId === currentUser.id) return;
    try {
      const participant = await ConigAPI.request("/api/users/" + encodeURIComponent(userId));
      const existing = conversations.find(item => item.participant?.userId === userId);
      activeConversation = existing || {
        conversationId: null,
        participant: {
          userId,
          username: participant.username,
          homeRegion: participant.homeRegion
        }
      };
      renderConversationList();
      await loadHistory();
    } catch (error) {
      alert("No se pudo abrir el chat: " + error.message);
    }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!activeConversation?.participant?.userId) {
      return alert("Selecciona una conversación o abre un perfil para iniciar un chat.");
    }

    const content = form.content.value.trim();
    if (!content) return;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await ConigAPI.request("/api/messages/" + encodeURIComponent(activeConversation.participant.userId), {
        method: "POST",
        data: { content }
      });
      form.reset();
      await loadConversations();
      const savedConversation = conversations.find(
        item => item.participant?.userId === activeConversation.participant.userId
      );
      if (savedConversation) activeConversation = savedConversation;
      renderConversationList();
      await loadHistory();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  });

  try {
    currentUser = await ConigAPI.request("/api/me");
    await loadConversations();
    if (requestedUserId) await openRequestedConversation(requestedUserId);
  } catch (error) {
    history.textContent = error.message;
  }
});
