const isStaffOrDelivery = (req, res, next) => {
  const role = req.user.role?.toLowerCase();
  if (role !== "admin" && role !== "staff" && role !== "delivery") {
    return res.status(403).json({ error: "Staff, Admin, or Delivery access required" });
  }
  next();
};

module.exports = isStaffOrDelivery;
