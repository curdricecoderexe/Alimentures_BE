const admin = require("firebase-admin");
const db = require("../config/firebase");
const { sendMail } = require("../utils/mailer");
const log = require("../lib/logger");
const { issueOtp, verifyOtp, OTP_ERROR_MESSAGE } = require("../utils/otp");
const { LIMITS } = require("../config/constants");
const { createAuditLog } = require("../services/auditService");
const { invalidateUser } = require("../utils/firebaseAuth");

const audit = (req, action, resourceId, prev, next) => createAuditLog({
  adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
  action, resourceId, previousState: prev || null, newState: next || null, ipAddress: req.ip,
});

// ── Per-account login lockout (complements the IP rate limiter) ──
const loginKey = (email) => `login_${Buffer.from(String(email).toLowerCase().trim()).toString("base64url")}`;

async function checkLoginLock(email) {
  const doc = await db.collection("loginAttempts").doc(loginKey(email)).get();
  if (doc.exists) {
    const d = doc.data();
    const until = d.lockedUntil?.toMillis ? d.lockedUntil.toMillis() : 0;
    if (until > Date.now()) return Math.ceil((until - Date.now()) / 60000);
  }
  return 0;
}

async function recordLoginFailure(email) {
  const ref = db.collection("loginAttempts").doc(loginKey(email));
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const count = (snap.exists ? snap.data().failCount || 0 : 0) + 1;
    const update = { failCount: count, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (count >= LIMITS.LOGIN_MAX_ATTEMPTS) {
      update.lockedUntil = admin.firestore.Timestamp.fromMillis(Date.now() + LIMITS.LOGIN_LOCK_MS);
      update.failCount = 0;
    }
    t.set(ref, update, { merge: true });
  });
}

async function clearLoginFailures(email) {
  await db.collection("loginAttempts").doc(loginKey(email)).delete().catch(() => {});
}

exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const lockedMins = await checkLoginLock(email);
    if (lockedMins > 0) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${lockedMins} minute(s).` });
    }

    const apiKey = process.env.FIREBASE_WEB_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Server configuration missing FIREBASE_WEB_API_KEY" });
    }

    // Call Firebase Auth REST API to sign in
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true
      })
    });

    const data = await response.json();

    if (!response.ok) {
      await recordLoginFailure(email);
      log.warn("auth.login_failed", { requestId: req.id, ip: req.ip });
      return res.status(401).json({ error: "Invalid email or password" });
    }
    await clearLoginFailures(email);

    // Get user details from Firestore
    const userDoc = await db.collection("users").doc(data.localId).get();
    let role = "customer";
    let name = "Customer";
    let isActive = true;

    if (userDoc.exists) {
      const userData = userDoc.data();
      role = userData.role;
      name = userData.name || "Customer";
      isActive = userData.isActive !== false;
    } else {
      // Auto-create missing Firestore profile for existing Auth users
      await db.collection("users").doc(data.localId).set({
        name: data.displayName || "Customer",
        email: data.email || email,
        role: "customer",
        isActive: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    if (!isActive) {
      return res.status(403).json({
        success: false,
        error: "Your account has been deactivated. Please contact support."
      });
    }

    // Password verified. Every login (any role) must also clear an OTP step
    // before a token is handed out — stash the signed-in session server-side
    // and release it only once verifyLoginOtp confirms the code.
    const otp = await issueOtp("login_otps", email);

    // The pending-session write and the OTP email are independent — fire them
    // together instead of waiting on one before starting the other.
    const [, emailResult] = await Promise.all([
      db.collection("login_pending").doc(email).set({
        token: data.idToken,
        uid: data.localId,
        role,
        name,
        email: data.email || email,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
      sendMail(
        email,
        "Your Login OTP - Alimenture",
        `Your one-time login code is ${otp}. It expires in 10 minutes. Do not share it with anyone.`,
        `<div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
           <h2>Verify it's you</h2>
           <p>Your One-Time Password (OTP) to complete sign-in is:</p>
           <h1 style="color: #E83D6E; letter-spacing: 5px;">${otp}</h1>
           <p>Enter this code to finish signing in. If you didn't try to log in, you can ignore this email.</p>
         </div>`
      ),
    ]);

    if (!emailResult.success) {
      log.error("otp.login_email_failed", { requestId: req.id, err: emailResult.error });
      return res.status(502).json({
        error: "We couldn't send the verification code right now. Please try again in a moment.",
      });
    }

    return res.status(200).json({
      success: true,
      otpRequired: true,
      email: data.email || email,
      message: "Enter the OTP sent to your email to complete login.",
    });
  } catch (err) {
    console.error("Error in loginUser:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// POST /api/users/login/verify-otp — second factor after loginUser. Releases
// the pending session (token/uid/role/name) that loginUser stashed once the
// OTP mailed to the account is confirmed.
exports.verifyLoginOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ error: "Email and OTP are required" });
    }

    const pendingRef = db.collection("login_pending").doc(email);

    // The OTP check and the pending-session lookup don't depend on each
    // other — run them together instead of two round-trips back to back.
    const [result, pendingSnap] = await Promise.all([
      verifyOtp("login_otps", email, String(otp)),
      pendingRef.get(),
    ]);

    if (!result.ok) {
      const status = result.reason === "locked" ? 429 : 400;
      return res.status(status).json({ error: OTP_ERROR_MESSAGE[result.reason] || "Invalid OTP" });
    }
    if (!pendingSnap.exists) {
      return res.status(400).json({ error: "Login session expired. Please sign in again." });
    }
    const pending = pendingSnap.data();
    pendingRef.delete().catch(() => {}); // best-effort cleanup, don't block the response

    return res.status(200).json({
      success: true,
      token: pending.token,
      uid: pending.uid,
      role: pending.role,
      name: pending.name,
      email: pending.email,
      message: "Login successful",
    });
  } catch (err) {
    console.error("Error in verifyLoginOtp:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// POST /api/users/logout — invalidate every existing token for this user.
exports.logoutUser = async (req, res) => {
  try {
    const uid = req.user.uid;
    await Promise.all([
      db.collection("users").doc(uid).update({
        tokensValidAfter: admin.firestore.FieldValue.serverTimestamp(),
      }),
      admin.auth().revokeRefreshTokens(uid).catch(() => {}),
    ]);
    invalidateUser(uid);
    return res.status(200).json({ success: true, message: "Signed out" });
  } catch (err) {
    log.error("user.logout_failed", { requestId: req.id, err });
    // Even if the server-side revoke fails, the client will clear local state.
    return res.status(200).json({ success: true, message: "Signed out" });
  }
};

exports.sendRegisterOtp = async (req, res) => {
  const generic = { success: true, message: "If that email can be registered, a verification code has been sent." };
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email is required" });

    let alreadyRegistered = false;
    try {
      await admin.auth().getUserByEmail(email);
      alreadyRegistered = true;
    } catch (authErr) {
      if (authErr.code !== 'auth/user-not-found') {
        console.error("Error checking existing user:", authErr);
        return res.status(500).json({ error: "Internal server error" });
      }
    }

    if (alreadyRegistered) {
      // Tell the user directly — a "code sent" screen they can never complete is
      // worse UX than a clear "you already have an account". (This trades away
      // the account-existence oracle on this endpoint; the tighter otpLimiter
      // still caps probing.)
      return res.status(409).json({
        error: "This email is already registered. Please sign in instead.",
        alreadyRegistered: true,
      });
    }

    // Hashed, expiring, attempt-limited OTP (utils/otp)
    const otp = await issueOtp("otps", email);
    const emailResult = await sendMail(
      email,
      "Your Registration OTP - Alimenture",
      `Your one-time registration code is ${otp}. It expires in 10 minutes. Do not share it with anyone.`,
      `<div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
         <h2>Welcome to Alimenture!</h2>
         <p>Your One-Time Password (OTP) for registration is:</p>
         <h1 style="color: #E83D6E; letter-spacing: 5px;">${otp}</h1>
         <p>Please enter this code to complete your registration. Do not share this code with anyone.</p>
       </div>`
    );

    if (!emailResult.success) {
      log.error("otp.register_email_failed", { requestId: req.id, err: emailResult.error });
      return res.status(502).json({
        error: "We couldn't send the verification code right now. Please try again in a moment.",
      });
    }

    return res.status(200).json(generic);
  } catch (err) {
    console.error("Error in sendRegisterOtp:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

exports.createUser = async (req, res) => {
  const { password, name, otp, role } = req.body;
  const email = String(req.body.email || "").trim().toLowerCase();
  const isRequesterAdmin = req.user && req.user.role?.toLowerCase() === 'admin';

  if (!email || !password || !name) {
    return res.status(400).json({ error: "Missing required fields: email, password, name" });
  }

  // Verify the OTP FIRST for non-admin registration, so this endpoint can't be
  // used as an account-existence oracle by someone without inbox control.
  if (!isRequesterAdmin) {
    if (!otp) {
      return res.status(400).json({ error: "OTP is required for registration" });
    }
    const result = await verifyOtp("otps", email, String(otp));
    if (!result.ok) {
      const status = result.reason === "locked" ? 429 : 400;
      return res.status(status).json({ error: OTP_ERROR_MESSAGE[result.reason] || "Invalid OTP" });
    }
  }

  // Now safe to reveal existence — the caller proved inbox control, or is an admin.
  try {
    await admin.auth().getUserByEmail(email);
    return res.status(409).json({ error: "Email is already registered. Please login instead." });
  } catch (authErr) {
    if (authErr.code !== 'auth/user-not-found') {
      console.error("Error checking existing user in createUser:", authErr);
    }
  }

  let userRecord;
  try {
   
    userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: name,
    });

    
    await db.collection("users").doc(userRecord.uid).set({
      name,
      email,
      role: isRequesterAdmin ? (role || "customer") : "customer",
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(201).json({ 
      success: true, 
      uid: userRecord.uid,
      message: "User created successfully" 
    });

  } catch (err) {
    if (userRecord) {
      await admin.auth().deleteUser(userRecord.uid).catch(() => {});
    }
    log.error("user.create_failed", { requestId: req.id, code: err.code, err });

    if (err.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: "Email is already registered" });
    }
    if (err.code === 'auth/invalid-password' || err.code === 'auth/weak-password') {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    return res.status(500).json({ error: "Failed to create account" });
  }
};
exports.getUsers = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const lastId = req.query.lastId;

    let query = db.collection("users").orderBy("createdAt", "desc").limit(limit);

    if (lastId) {
      const lastDoc = await db.collection("users").doc(lastId).get();
      if (lastDoc.exists) {
        query = query.startAfter(lastDoc);
      }
    }

    const snapshot = await query.get();
    const users = snapshot.docs.map(doc => ({
      uid: doc.id,
      ...doc.data()
    }));

    return res.status(200).json({
      success: true,
      count: users.length,
      data: users
    });
  } catch (err) {
    console.error("Error in getUsers:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch users" });
  }
};

exports.getUser = async (req, res) => {
  try {
    const { uid } = req.params;

    // IDOR Protection — staff can look up a customer's profile (needed for
    // support-chat context), same read access admin already has.
    const role = req.user?.role?.toLowerCase();
    if (!['admin', 'staff'].includes(role) && req.user?.uid !== uid) {
      return res.status(403).json({ error: "Forbidden: You do not have access to this user profile" });
    }

    const doc = await db.collection("users").doc(uid).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.status(200).json({ uid: doc.id, ...doc.data() });
  } catch (err) {
    console.error("Error in getUser:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
// Fields a user may change on their own profile (or an admin on anyone's).
const USER_WRITABLE_FIELDS = ['name', 'phone', 'photoURL', 'preferences'];

exports.updateUser = async (req, res) => {
  try {
    const { uid } = req.params;

    // IDOR Protection
    const role = req.user?.role;
    if (role !== 'admin' && req.user?.uid !== uid) {
      return res.status(403).json({ error: "Forbidden: You do not have permission to update this user" });
    }

    const updates = {};
    for (const k of USER_WRITABLE_FIELDS) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }
    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    const userRef = db.collection("users").doc(uid);
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: "User does not exist" });

    await userRef.update(updates);
    return res.status(200).json({ success: true, message: "User updated" });
  } catch (err) {
    log.error("user.update_failed", { requestId: req.id, err });
    return res.status(500).json({ error: "Failed to update user" });
  }
};

// PATCH /api/users/:uid/role  (admin) — the only path that can change a role.
exports.setUserRole = async (req, res) => {
  try {
    const { uid } = req.params;
    const newRole = String(req.body.role || '').toLowerCase();
    if (!['admin', 'staff', 'customer'].includes(newRole)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (uid === req.user.uid && newRole !== 'admin') {
      return res.status(400).json({ error: "You cannot remove your own admin role" });
    }

    const userRef = db.collection("users").doc(uid);
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: "User not found" });

    const prevRole = doc.data().role;
    await userRef.update({ role: newRole, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    audit(req, 'SET_USER_ROLE', uid, { role: prevRole }, { role: newRole });
    invalidateUser(uid);

    return res.status(200).json({ success: true, message: "Role updated", role: newRole });
  } catch (err) {
    log.error("user.set_role_failed", { requestId: req.id, err });
    return res.status(500).json({ error: "Failed to update role" });
  }
};

exports.softDeleteUser = async (req, res) => {
  try {
    const { uid } = req.params;
    const ref = db.collection("users").doc(uid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "User not found" });

    await ref.update({ isActive: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    audit(req, 'DEACTIVATE_USER', uid, { isActive: doc.data().isActive }, { isActive: false });
    invalidateUser(uid);
    return res.status(200).json({ success: true, message: "User deactivated" });
  } catch (err) {
    log.error("user.soft_delete_failed", { requestId: req.id, err });
    return res.status(500).json({ error: "Failed to deactivate user" });
  }
};

exports.toggleUserStatus = async (req, res) => {
  try {
    const { uid } = req.params;
    const userRef = db.collection("users").doc(uid);
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).json({ error: "User not found" });

    const currentStatus = doc.data().isActive ?? true;
    await userRef.update({ isActive: !currentStatus });
    audit(req, 'TOGGLE_USER_STATUS', uid, { isActive: currentStatus }, { isActive: !currentStatus });
    invalidateUser(uid);
    return res.status(200).json({ success: true, isActive: !currentStatus });
  } catch (err) {
    log.error("user.toggle_status_failed", { requestId: req.id, err });
    return res.status(500).json({ error: "Failed to toggle status" });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ error: "User ID is required" });
    if (uid === req.user.uid) return res.status(400).json({ error: "You cannot delete your own account here" });

    let email = null;
    try {
      const rec = await admin.auth().getUser(uid);
      email = rec.email;
      await admin.auth().deleteUser(uid);
    } catch (authErr) {
      log.warn("user.auth_delete_warning", { uid, code: authErr.code });
    }

    await db.collection("users").doc(uid).delete();
    audit(req, 'DELETE_USER', uid, { email }, null);
    invalidateUser(uid);

    return res.status(200).json({ success: true, message: "User deleted successfully" });
  } catch (err) {
    log.error("user.delete_failed", { requestId: req.id, err });
    return res.status(500).json({ error: "Failed to delete user" });
  }
};
exports.requestPasswordResetOtp = async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email is required" });

    // Generic response regardless of whether the account exists (no enumeration).
    const genericOk = { success: true, message: "If an account exists for that email, a reset code has been sent." };

    let userExists = true;
    try {
      await admin.auth().getUserByEmail(email);
    } catch (e) {
      userExists = false;
    }

    if (userExists) {
      const otp = await issueOtp("password_otps", email);
      const emailResult = await sendMail(
        email,
        "Password Reset OTP - Alimenture",
        `Your password reset code is ${otp}. It expires in 10 minutes. Do not share it with anyone.`,
        `<div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
           <h2>Reset Your Password</h2>
           <p>Your OTP for password reset is:</p>
           <h1 style="color: #E83D6E; letter-spacing: 5px;">${otp}</h1>
           <p>This code expires in 10 minutes. Do not share it with anyone.</p>
         </div>`
      );
      if (!emailResult.success) {
        log.error("otp.reset_email_failed", { requestId: req.id, err: emailResult.error });
        return res.status(502).json({
          error: "We couldn't send the reset code right now. Please try again in a moment.",
        });
      }
    }

    return res.status(200).json(genericOk);
  } catch (err) {
    log.error("otp.reset_request_failed", { requestId: req.id, err });
    return res.status(500).json({ error: "Internal server error" });
  }
};

exports.resetPasswordWithOtp = async (req, res) => {
  try {
    const { otp, newPassword } = req.body;
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email || !otp || !newPassword) return res.status(400).json({ error: "All fields are required" });
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const result = await verifyOtp("password_otps", email, String(otp));
    if (!result.ok) {
      const status = result.reason === "locked" ? 429 : 400;
      return res.status(status).json({ error: OTP_ERROR_MESSAGE[result.reason] || "Invalid or expired code" });
    }

    // Update password in Auth
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(user.uid, { password: newPassword });

    // Invalidate every existing session — a stolen token must not survive a reset.
    await Promise.all([
      admin.auth().revokeRefreshTokens(user.uid).catch(() => {}),
      db.collection("users").doc(user.uid).update({
        tokensValidAfter: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {}),
    ]);
    invalidateUser(user.uid);

    return res.status(200).json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Failed to reset password" });
  }
};