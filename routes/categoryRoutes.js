'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/categoryController');
const verifyToken = require('../middlewares/verifyToken');
const isAdmin = require('../middlewares/isAdmin');
const { validate } = require('../middlewares/validate');
const { writeLimiter } = require('../middlewares/rateLimiters');

const nameField = (required) => ({ type: 'string', trim: true, max: 40, required });

// Public — the shop's filter list.
router.get('/', ctrl.getCategories);

// Admin.
router.get('/admin', verifyToken, isAdmin, ctrl.getAdminCategories);
router.post('/', verifyToken, isAdmin, writeLimiter, validate({ body: { name: nameField(true) } }), ctrl.createCategory);
router.put('/order', verifyToken, isAdmin, writeLimiter, ctrl.reorderCategories);
router.put('/:id', verifyToken, isAdmin, writeLimiter, validate({
  body: { name: nameField(false), visible: { type: 'boolean' } },
}), ctrl.updateCategory);
router.delete('/:id', verifyToken, isAdmin, writeLimiter, ctrl.deleteCategory);

module.exports = router;
