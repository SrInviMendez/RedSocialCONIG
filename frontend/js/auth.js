document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("loginForm");

  if (loginForm) {
    loginForm.addEventListener("submit", async event => {
      event.preventDefault();

      const button = loginForm.querySelector("button[type=submit]");
      const message = document.getElementById("formMessage");

      button.disabled = true;
      message.textContent = "Verificando tus datos...";

      try {
        const data = await ConigAPI.request("/api/auth/login", {
          method: "POST",
          auth: false,
          data: {
            identifier: loginForm.elements.identifier.value.trim(),
            password: loginForm.elements.password.value
          }
        });

        sessionStorage.setItem("conig_token", data.token);

        // La asignación regional permanece exclusivamente en el backend/JWT.
        const user = { ...data.user };
        delete user.homeRegion;

        sessionStorage.setItem("conig_user", JSON.stringify(user));

        window.location.href = "index.html";

      } catch (error) {
        message.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }

  const registerForm = document.getElementById("registerForm");

  if (registerForm) {
    registerForm.addEventListener("submit", async event => {
      event.preventDefault();

      const button = registerForm.querySelector("button[type=submit]");
      const message = document.getElementById("formMessage");

      button.disabled = true;
      message.textContent = "Creando tu cuenta...";

      try {
        await ConigAPI.request("/api/auth/register", {
          method: "POST",
          auth: false,
          data: new FormData(registerForm),
          timeoutMs: 120000
        });

        message.textContent =
          "Cuenta creada correctamente. Ya puedes iniciar sesión.";

        registerForm.reset();

        setTimeout(() => {
          window.location.href = "login.html";
        }, 1500);

      } catch (error) {
        message.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }
});