const isAdmin = (req, res, next) => {
  if (req.user.role?.toLowerCase() !== "admin") {
    return res.status(403).json({ error: "Admin only access" });
  }
  next();
};

module.exports = isAdmin;