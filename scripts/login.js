document.getElementById("loginForm").addEventListener("submit", function(e) {
    e.preventDefault();
    
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value.trim();

    // Hardcoded credentials (change as needed)
    const ADMIN_USER = "admin";
    const ADMIN_PASS = "weare11";

    if (username === ADMIN_USER && password === ADMIN_PASS) {
        localStorage.setItem("isAdmin", "true");
        window.location.href = "./admin.html"; // redirect
    } else {
        document.getElementById("errorMsg").classList.remove("hidden");
    }
});
