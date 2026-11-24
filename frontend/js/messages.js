document.addEventListener("DOMContentLoaded", async () => {
  if (!ConigAPI.requireAuth()) return;

  const list = document.getElementById("conversationList");
  const history = document.getElementById("messageHistory");
  const form = document.getElementById("messageForm");

  let activeConversation = null;
  let currentUser = null;

  function node(tag, cls, text) {
    const element = document.createElement(tag);
    element.className = cls || "";
    if (text !== undefined) element.textContent = text;
    return element;
  }

  async function loadConversations() {
    list.textContent = "Cargando conversaciones...";

    try {
      const data = await ConigAPI.request("/api/conversations");
      list.replaceChildren();

      if (!data.conversations.length) {
        list.textContent = "Todavía no tienes conversaciones.";
        return;
      }

      data.conversations.forEach(conversation => {
        if (!conversation.participant) return;

        const button = node("button", "conversation-entry",
          conversation.participant.username);

        button.addEventListener("click", () => {
          activeConversation = conversation;
          loadHistory();
        });

        list.append(button);
      });

    } catch (error) {
      list.textContent = error.message;
    }
  }

  async function loadHistory() {
    if (!activeConversation) return;

    history.textContent = "Cargando mensajes...";

    try {
      const id = encodeURIComponent(activeConversation.conversationId);
      const data = await ConigAPI.request(
        `/api/conversations/${id}/messages`
      );

      history.replaceChildren();

      data.messages.forEach(message => {
        const mine = message.senderId === currentUser.id;
        const bubble = node(
          "div",
          `message-bubble ${mine ? "message-mine" : "message-other"}`,
          message.content
        );

        const date = node("small", "text-secondary d-block mt-1",
          new Date(message.createdAt).toLocaleString("es-CO"));

        const wrapper = node("div", mine ? "message-row mine" : "message-row");
        wrapper.append(bubble, date);

        if (!mine && message.deliveryStatus !== "read") {
          const read = node("button", "btn btn-sm btn-link",
            "Marcar como leído");

          read.addEventListener("click", async () => {
            try {
              await ConigAPI.request(
                `/api/messages/${encodeURIComponent(message.messageId)}/read`,
                { method: "PATCH" }
              );
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

  form.addEventListener("submit", async event => {
    event.preventDefault();

    if (!activeConversation?.participant?.userId) {
      return alert("Selecciona una conversación.");
    }

    const content = form.content.value.trim();
    if (!content) return;

    const button = form.querySelector("button");
    button.disabled = true;

    try {
      await ConigAPI.request(
        `/api/messages/${activeConversation.participant.userId}`,
        {
          method: "POST",
          data: { content }
        }
      );

      form.reset();
      await loadHistory();
      await loadConversations();

    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  });

  try {
    currentUser = await ConigAPI.request("/api/me");
    await loadConversations();
  } catch (error) {
    history.textContent = error.message;
  }
});