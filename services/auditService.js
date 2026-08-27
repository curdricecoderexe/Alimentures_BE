const db = require('../config/firebase');
const admin = require('firebase-admin');

/**
 * Creates an audit log for sensitive admin operations
 * @param {Object} params
 * @param {string} params.adminId - UID of the admin
 * @param {string} params.adminEmail - Email of the admin
 * @param {string} params.action - E.g. UPDATE_ORDER_STATUS, UPDATE_INVENTORY
 * @param {string} params.resourceId - ID of the modified resource (Order ID, Product ID)
 * @param {Object} params.previousState - State before change
 * @param {Object} params.newState - State after change
 * @param {string} params.ipAddress - Client IP address
 */
exports.createAuditLog = async ({ adminId, adminEmail, action, resourceId, previousState, newState, ipAddress }) => {
    try {
        await db.collection('audit_logs').add({
            adminId,
            adminEmail: adminEmail || 'unknown',
            action,
            resourceId,
            previousState: previousState || null,
            newState: newState || null,
            ipAddress: ipAddress || 'unknown',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) {
        console.error("Failed to create audit log:", e);
    }
};
