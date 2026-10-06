export const normalizeRole = (role) => String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

export const isSchoolAdministrator = (role) => [
    'admin',
    'user',
    'school-admin',
    'principal',
    'super-admin',
    'headteacher',
    'deputy-headteacher',
].includes(normalizeRole(role));

export const isHeadteacher = (role) => normalizeRole(role) === 'headteacher';
export const isDeputyHeadteacher = (role) => normalizeRole(role) === 'deputy-headteacher';
