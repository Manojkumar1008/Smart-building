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

const registerForm = document.getElementById("registerForm");
const registerError = document.getElementById("registerError");
const registerBtn = document.getElementById("registerBtn");

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  registerError.textContent = "";
  registerBtn.disabled = true;
  registerBtn.textContent = "Creating Account...";

  const username = String(document.getElementById("regUsername").value || "").trim();
  const password = String(document.getElementById("regPassword").value || "");
  const confirm = String(document.getElementById("regConfirm").value || "");

  if (password !== confirm) {
    registerError.textContent = "Passwords do not match.";
    registerBtn.disabled = false;
    registerBtn.textContent = "Create Account";
    return;
  }

  try {
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      registerError.textContent = payload.message || "Registration failed. Please try again.";
      return;
    }

    // Success -> redirect
    window.location.href = "/";
  } catch (error) {
    console.error("Registration failed", error);
    registerError.textContent = "Unable to reach server. Please retry.";
  } finally {
    registerBtn.disabled = false;
    registerBtn.textContent = "Create Account";
  }
});

let isRegistering = false;
document.getElementById("toggleFormBtn").addEventListener("click", () => {
  isRegistering = !isRegistering;
  const tBtn = document.getElementById("toggleFormBtn");
  const pTitle = document.getElementById("panelTitle");
  const pHint = document.getElementById("panelHint");

  if (isRegistering) {
    loginForm.style.display = "none";
    registerForm.style.display = "block";
    tBtn.textContent = "Already have an account? Sign in";
    pTitle.textContent = "Create Account";
    pHint.textContent = "Register for immediate dashboard access.";
  } else {
    registerForm.style.display = "none";
    loginForm.style.display = "block";
    tBtn.textContent = "Don't have an account? Sign up";
    pTitle.textContent = "Sign In";
    pHint.textContent = "Use your dashboard credentials to continue.";
  }
});
