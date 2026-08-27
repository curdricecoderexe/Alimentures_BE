const isStaff = (req, res, next) => {
  const role = req.user.role?.toLowerCase();
  if (role !== "admin" && role !== "staff") {
    return res.status(403).json({ error: "Staff or Admin access required" });
  }
  next();
};

module.exports = isStaff;
