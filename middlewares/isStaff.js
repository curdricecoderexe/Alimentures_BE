const isStaff = (req, res, next) => {
  const role = req.user.role?.toLowerCase();
  if (role !== "admin" && role !== "staff") {
    return res.status(403).json({ success: false, error: "Forbidden" }); // generic: never reveal role names
  }
  next();
};

module.exports = isStaff;
