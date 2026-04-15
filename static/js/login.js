const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");
const loginBtn = document.getElementById("loginBtn");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  loginBtn.disabled = true;
  loginBtn.textContent = "Signing in...";

  const username = String(document.getElementById("username").value || "").trim();
  const password = String(document.getElementById("password").value || "");

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      loginError.textContent = payload.message || "Login failed. Please try again.";
      return;
    }

    window.location.href = "/";
  } catch (error) {
    console.error("Login failed", error);
    loginError.textContent = "Unable to reach server. Please retry.";
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Enter Dashboard";
  }
});
