const isAdmin = (req, res, next) => {
  if (req.user.role?.toLowerCase() !== "admin") {
    return res.status(403).json({ success: false, error: "Forbidden" }); // generic: never reveal role names
  }
  next();
};

module.exports = isAdmin;