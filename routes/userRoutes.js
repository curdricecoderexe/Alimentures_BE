const express = require("express");
const router = express.Router();
const {
  createUser,
  loginUser,
  verifyLoginOtp,
  getUsers,
  getUser,
  updateUser,
  softDeleteUser,
  deleteUser,
  requestPasswordResetOtp,
  resetPasswordWithOtp,
  sendRegisterOtp,
  toggleUserStatus,
  setUserRole,
  logoutUser
} = require("../controllers/userController");

const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const optionalAuth = require("../middlewares/optionalAuth");
const { authLimiter, otpLimiter } = require("../middlewares/rateLimiters");

// PUBLIC
router.post("/send-otp", otpLimiter, sendRegisterOtp);
router.post("/register", otpLimiter, createUser);
router.post("/login", authLimiter, loginUser);
router.post("/login/verify-otp", otpLimiter, verifyLoginOtp);
router.post("/request-reset", otpLimiter, requestPasswordResetOtp);
router.post("/reset-password", otpLimiter, resetPasswordWithOtp);

// PROTECTED
router.post("/logout", optionalAuth, logoutUser); // always clears the session cookies
// The signed-in user's own profile — same handler and checks as /:uid.
router.get("/me", verifyToken, (req, res, next) => { req.params.uid = req.user.uid; next(); }, getUser);
router.put("/me", verifyToken, (req, res, next) => { req.params.uid = req.user.uid; next(); }, updateUser);
router.get("/", verifyToken, isAdmin, getUsers);
router.get("/:uid", verifyToken, getUser);
router.put("/:uid", verifyToken, updateUser);

// ADMIN ONLY
router.patch("/toggle-status/:uid", verifyToken, isAdmin, toggleUserStatus);
router.patch("/:uid/role", verifyToken, isAdmin, setUserRole);
router.put("/:uid/role", verifyToken, isAdmin, setUserRole); // FE compat
router.post("/admin-create", verifyToken, isAdmin, createUser);
router.patch("/soft-delete/:uid", verifyToken, isAdmin, softDeleteUser);
router.delete("/:uid", verifyToken, isAdmin, deleteUser);

module.exports = router;