const { requireAuth, json, errorResponse } = require('./_lib/chatbotAuth');
const { initAdmin } = require('./_lib/firebaseAdmin');
const { withCors } = require('./_lib/cors');

const ROLE_LIMITS = {
    admin: 1,
    headteacher: 1,
    'deputy-headteacher': 2,
    accountant: 2,
};
const ROLE_ALIASES = {
    user: 'admin',
    school_admin: 'admin',
    principal: 'admin',
    finance: 'accountant',
};
const MANAGED_ROLES = new Set(Object.keys(ROLE_LIMITS));

function normalizeRole(role) {
    const normalized = String(role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return ROLE_ALIASES[normalized] || normalized.replace(/_/g, '-');
}

function requireProfileManager(user) {
    const role = String(user.role || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (!['admin', 'headteacher'].includes(role)) {
        throw Object.assign(new Error('Only an Admin or HeadTeacher can manage school administrators.'), {
            statusCode: 403,
        });
    }
}

function requirePlatformAdmin(user) {
    const role = String(user.role || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (role !== 'super-admin') {
        throw Object.assign(new Error('Platform administrator access is required.'), {
            statusCode: 403,
        });
    }
}

function countManagedRoles(users, schoolId) {
    const counts = Object.fromEntries(Object.keys(ROLE_LIMITS).map((role) => [role, 0]));
    users.forEach((snapshot) => {
        const data = snapshot.data() || {};
        if (data.schoolId !== schoolId) return;
        const role = normalizeRole(data.role);
        if (Object.hasOwn(counts, role)) counts[role] += 1;
    });
    return counts;
}

async function addAdmin({ db, user, body, platformAdmin = false }) {
    if (platformAdmin) requirePlatformAdmin(user);
    else requireProfileManager(user);
    const email = String(body.email || '').trim().toLowerCase();
    const role = normalizeRole(body.role);
    const schoolId = platformAdmin ? String(body.schoolId || '').trim() : user.schoolId;
    if (!email || !MANAGED_ROLES.has(role)) {
        throw Object.assign(new Error('A valid email and administrator role are required.'), {
            statusCode: 400,
        });
    }
    if (!schoolId) {
        throw Object.assign(new Error('The target school is required.'), { statusCode: 400 });
    }

    const matches = await db.collection('users').where('email', '==', email).limit(5).get();
    const targetSnapshot = matches.docs.find((snapshot) => {
        const target = snapshot.data() || {};
        return !target.schoolId || target.schoolId === schoolId;
    });
    if (!targetSnapshot) {
        if (!matches.empty) {
            throw Object.assign(new Error('This account already belongs to another school.'), {
                statusCode: 409,
            });
        }
        throw Object.assign(new Error('User not found. Ensure the person has registered first.'), {
            statusCode: 404,
        });
    }

    const schoolRef = db.collection('schools').doc(schoolId);
    const targetRef = targetSnapshot.ref;
    const schoolUsers = await db.collection('users')
        .where('schoolId', '==', schoolId)
        .get();
    const initialCounts = countManagedRoles(schoolUsers.docs, schoolId);
    const now = new Date().toISOString();

    await db.runTransaction(async (transaction) => {
        const [schoolSnapshot, currentTargetSnapshot] = await Promise.all([
            transaction.get(schoolRef),
            transaction.get(targetRef),
        ]);
        if (!schoolSnapshot.exists) {
            throw Object.assign(new Error('School not found.'), { statusCode: 404 });
        }
        if (!currentTargetSnapshot.exists) {
            throw Object.assign(new Error('User not found.'), { statusCode: 404 });
        }

        const target = currentTargetSnapshot.data() || {};
        if (target.schoolId && target.schoolId !== schoolId) {
            throw Object.assign(new Error('This account already belongs to another school.'), {
                statusCode: 409,
            });
        }
        const oldRole = target.schoolId === schoolId ? normalizeRole(target.role) : '';
        const counts = schoolSnapshot.get('adminRoleCountsInitialized')
            ? { ...schoolSnapshot.get('adminRoleCounts') }
            : { ...initialCounts };

        Object.keys(ROLE_LIMITS).forEach((roleKey) => {
            counts[roleKey] = Number.isFinite(Number(counts[roleKey]))
                ? Number(counts[roleKey])
                : 0;
        });

        if (oldRole !== role && counts[role] >= ROLE_LIMITS[role]) {
            throw Object.assign(
                new Error(`The ${role.replace(/-/g, ' ')} role is already at its limit (${ROLE_LIMITS[role]}).`),
                { statusCode: 409 }
            );
        }
        if (MANAGED_ROLES.has(oldRole) && oldRole !== role) {
            counts[oldRole] = Math.max(0, counts[oldRole] - 1);
        }
        if (oldRole !== role) counts[role] += 1;

        transaction.update(targetRef, {
            role,
            schoolId,
            ...(body.firstName ? { firstName: String(body.firstName).trim() } : {}),
            ...(body.lastName ? { lastName: String(body.lastName).trim() } : {}),
            ...(body.phone ? { phone: String(body.phone).trim() } : {}),
            ...(body.firstName || body.lastName
                ? { fullName: [body.firstName, body.lastName].filter(Boolean).join(' ').trim() }
                : {}),
            updatedAt: now,
        });
        transaction.set(schoolRef, {
            adminRoleCounts: counts,
            adminRoleCountsInitialized: true,
            adminsUpdatedAt: now,
        }, { merge: true });
    });

    return { success: true };
}

async function requestDeletion({ db, user, body, platformAdmin = false }) {
    if (platformAdmin) requirePlatformAdmin(user);
    else requireProfileManager(user);
    const targetUid = String(body.targetUid || '').trim();
    if (!targetUid) {
        throw Object.assign(new Error('Choose an administrator account to remove.'), {
            statusCode: 400,
        });
    }

    const targetSnapshot = await db.collection('users').doc(targetUid).get();
    if (!targetSnapshot.exists) {
        throw Object.assign(new Error('Administrator account not found.'), { statusCode: 404 });
    }
    const target = targetSnapshot.data() || {};
    const targetRole = normalizeRole(target.role);
    const schoolId = platformAdmin ? target.schoolId : user.schoolId;
    if (!schoolId || target.schoolId !== schoolId || !MANAGED_ROLES.has(targetRole)) {
        throw Object.assign(new Error('This account is not a managed administrator in your school.'), {
            statusCode: 403,
        });
    }

    const requests = db.collection('school_admin_deletion_requests');
    const existingRequests = await requests.where('schoolId', '==', schoolId).get();
    const existingRequest = existingRequests.docs.find((snapshot) => {
        const request = snapshot.data() || {};
        return request.targetUid === targetUid && ['pending', 'deleting'].includes(request.status);
    });
    if (existingRequest) {
        return { success: true, requestId: existingRequest.id };
    }

    const requestRef = requests.doc();
    await requestRef.set({
        schoolId,
        targetUid,
        targetRole,
        targetName: target.fullName || [target.firstName, target.lastName].filter(Boolean).join(' '),
        targetEmail: target.email || '',
        requestedBy: user.uid,
        requestedByName: user.fullName || user.email,
        status: 'pending',
        requestedAt: new Date().toISOString(),
    });
    return { success: true, requestId: requestRef.id };
}

async function setPlatformRole({ db, user, body }) {
    requirePlatformAdmin(user);
    const targetUid = String(body.targetUid || '').trim();
    const role = normalizeRole(body.role);
    if (!targetUid || role !== 'admin') {
        throw Object.assign(new Error('Only assigning the Admin role is supported here.'), {
            statusCode: 400,
        });
    }
    const targetSnapshot = await db.collection('users').doc(targetUid).get();
    if (!targetSnapshot.exists) {
        throw Object.assign(new Error('User not found.'), { statusCode: 404 });
    }
    const target = targetSnapshot.data() || {};
    if (!target.schoolId || !target.email) {
        throw Object.assign(new Error('The user must have a school and email before assigning Admin.'), {
            statusCode: 400,
        });
    }
    const oldRole = normalizeRole(target.role);
    if (MANAGED_ROLES.has(oldRole) && oldRole !== role) {
        throw Object.assign(new Error('Managed administrator accounts must be deleted through the approval process, not reassigned.'), {
            statusCode: 409,
        });
    }
    if (oldRole === role) return { success: true };
    return addAdmin({
        db,
        user,
        platformAdmin: true,
        body: { email: target.email, role, schoolId: target.schoolId },
    });
}

async function listApprovalRequests({ db, user }) {
    const snapshot = await db.collection('school_admin_deletion_requests')
        .where('schoolId', '==', user.schoolId)
        .get();
    return {
        success: true,
        requests: snapshot.docs
            .filter((request) => {
                const data = request.data() || {};
                return data.targetUid === user.uid && ['pending', 'deleting'].includes(data.status);
            })
            .map((request) => ({ id: request.id, ...request.data() })),
    };
}

async function approveDeletion({ admin, db, user, body }) {
    const requestId = String(body.requestId || '').trim();
    if (!requestId) {
        throw Object.assign(new Error('requestId is required.'), { statusCode: 400 });
    }

    const requestRef = db.collection('school_admin_deletion_requests').doc(requestId);
    const requestSnapshot = await requestRef.get();
    if (!requestSnapshot.exists) {
        throw Object.assign(new Error('Deletion request not found.'), { statusCode: 404 });
    }
    const request = requestSnapshot.data() || {};
    if (request.targetUid !== user.uid || request.schoolId !== user.schoolId) {
        throw Object.assign(new Error('Only the account being removed can approve this request.'), {
            statusCode: 403,
        });
    }
    if (!['pending', 'deleting'].includes(request.status)) {
        throw Object.assign(new Error('This deletion request is no longer active.'), {
            statusCode: 409,
        });
    }

    const schoolRef = db.collection('schools').doc(user.schoolId);
    const targetRef = db.collection('users').doc(user.uid);
    await db.runTransaction(async (transaction) => {
        const currentRequest = await transaction.get(requestRef);
        if (!currentRequest.exists || !['pending', 'deleting'].includes(currentRequest.get('status'))) {
            throw Object.assign(new Error('This deletion request is no longer active.'), {
                statusCode: 409,
            });
        }
        if (currentRequest.get('status') === 'pending') {
            transaction.update(requestRef, {
                status: 'deleting',
                approvedAt: new Date().toISOString(),
            });
        }
    });

    try {
        await admin.auth().deleteUser(user.uid);
    } catch (error) {
        if (error.code !== 'auth/user-not-found') {
            await requestRef.update({ status: 'pending', deletionError: error.message });
            throw error;
        }
    }

    await db.runTransaction(async (transaction) => {
        const [currentRequest, targetSnapshot, schoolSnapshot] = await Promise.all([
            transaction.get(requestRef),
            transaction.get(targetRef),
            transaction.get(schoolRef),
        ]);
        if (!currentRequest.exists || currentRequest.get('status') !== 'deleting') {
            throw Object.assign(new Error('This deletion request has already been processed.'), {
                statusCode: 409,
            });
        }

        const targetRole = targetSnapshot.exists
            ? normalizeRole(targetSnapshot.get('role'))
            : normalizeRole(request.targetRole);
        if (targetSnapshot.exists && targetSnapshot.get('schoolId') !== user.schoolId) {
            throw Object.assign(new Error('Administrator school membership changed.'), {
                statusCode: 409,
            });
        }

        if (targetSnapshot.exists) transaction.delete(targetRef);
        if (schoolSnapshot.exists && schoolSnapshot.get('adminRoleCountsInitialized')) {
            const counts = { ...(schoolSnapshot.get('adminRoleCounts') || {}) };
            if (MANAGED_ROLES.has(targetRole)) {
                counts[targetRole] = Math.max(0, Number(counts[targetRole] || 0) - 1);
            }
            transaction.update(schoolRef, {
                adminRoleCounts: counts,
                adminsUpdatedAt: new Date().toISOString(),
            });
        }
        transaction.update(requestRef, {
            status: 'completed',
            completedAt: new Date().toISOString(),
        });
    });

    return { success: true };
}

async function handler(event) {
    if (event.httpMethod !== 'POST') {
        return json(405, { success: false, error: 'Method not allowed' });
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const platformAction = ['platform-request-deletion', 'platform-set-role'].includes(body.action);
        const user = await requireAuth(event, {
            healProfile: false,
            allowNoSchool: platformAction,
        });
        const admin = initAdmin();
        const db = admin.firestore();

        let result;
        switch (body.action) {
            case 'add-admin':
                result = await addAdmin({ db, user, body });
                break;
            case 'request-deletion':
                result = await requestDeletion({ db, user, body });
                break;
            case 'platform-request-deletion':
                result = await requestDeletion({ db, user, body, platformAdmin: true });
                break;
            case 'platform-set-role':
                result = await setPlatformRole({ db, user, body });
                break;
            case 'list-approval-requests':
                result = await listApprovalRequests({ db, user });
                break;
            case 'approve-deletion':
                result = await approveDeletion({ admin, db, user, body });
                break;
            default:
                return json(400, { success: false, error: 'Unsupported administrator action.' });
        }
        return json(200, result);
    } catch (error) {
        console.error('manage-school-admins failed:', error.message);
        return errorResponse(error);
    }
}

exports.handler = withCors(handler);
