// netlify/functions/chatbot-school-info.js
//
// Returns structured school facts for the chatbot.
//
// GET or POST. Body/query: { topic }
//   topic = 'overview' | 'classes' | 'subjects' | 'teachers' | 'contact' | 'levels' | 'all'
//
// Response: { success, topic, summary, data }
//
// CACHE: 12-hour TTL. School name, motto, classes, subjects, and
// contacts change rarely; a 12-hour cache slashes Firestore reads
// with no noticeable staleness for teachers.

const { requireAuth, json, errorResponse } = require('./_lib/chatbotAuth');
const { initAdmin } = require('./_lib/firebaseAdmin');
const { cacheGet, cacheSet } = require('./_lib/blobCache');

// 12 hours. Bump down if admin edits need to reach teachers faster
// without an explicit invalidation call.
const CACHE_TTL_SECONDS = 12 * 60 * 60;

const LEVEL_LABELS = {
    'pre-primary': 'Pre-Primary',
    'lower-primary': 'Lower Primary',
    'upper-primary': 'Upper Primary',
    'junior-school': 'Junior School',
    'senior-school': 'Senior School',
};

const LEVEL_ORDER = Object.keys(LEVEL_LABELS);

const DEFAULT_SUBJECTS = {
    'pre-primary': ['Language', 'Number Work', 'Environmental', 'Psychomotor', 'Creative'],
    'lower-primary': ['English', 'Kiswahili', 'Mathematics', 'Environmental', 'Religious Education', 'Creative Arts'],
    'upper-primary': ['English', 'Kiswahili', 'Mathematics', 'Science and Technology', 'Social Studies', 'Religious Education', 'Agriculture'],
    'junior-school': ['English', 'Kiswahili', 'Mathematics', 'Integrated Science', 'Social Studies', 'Religious Education', 'Pre-Technical Studies', 'Agriculture and Nutrition', 'Creative Arts and Sports'],
    'senior-school': ['English', 'Kiswahili', 'Mathematics', 'Biology', 'Chemistry', 'Physics', 'History', 'Geography', 'Business Studies', 'Computer Studies'],
};

// ------------------------------------------------------------
// SchoolProfile.jsx stores custom subjects as:
//     customSubjects: [{ id, level, name }, ...]
// The chatbot, however, needs a grouped map:
//     subjectsByLevel = { 'lower-primary': ['English', ...] }
// This helper adapts the page's shape into the chatbot's shape.
// ------------------------------------------------------------
function buildSubjectsByLevel(school) {
    const customSubjects = Array.isArray(school.customSubjects) ? school.customSubjects : [];
    if (school.useCustomSubjects && customSubjects.length > 0) {
        return customSubjects.reduce((acc, s) => {
            if (!s || !s.level || !s.name) return acc;
            (acc[s.level] = acc[s.level] || []).push(s.name);
            return acc;
        }, {});
    }
    return { ...DEFAULT_SUBJECTS };
}

// ------------------------------------------------------------
// Determine the ordered list of levels the school runs,
// based on `highestLevel`. Falls back gracefully if the value
// is a legacy one (e.g. "lower-secondary") that isn't in
// LEVEL_ORDER.
// ------------------------------------------------------------
function resolveLevels(highestLevel) {
    let highestIdx = LEVEL_ORDER.indexOf(highestLevel);
    if (highestIdx === -1) {
        highestIdx = LEVEL_ORDER.length - 1;
    }
    return LEVEL_ORDER.slice(0, highestIdx + 1);
}

exports.handler = async (event) => {
    try {
        const { schoolId } = await requireAuth(event);

        let topic = 'overview';
        if (event.httpMethod === 'GET') {
            topic = (event.queryStringParameters || {}).topic || 'overview';
        } else if (event.httpMethod === 'POST') {
            try {
                const body = JSON.parse(event.body || '{}');
                topic = body.topic || 'overview';
            } catch { /* keep default */ }
        } else {
            return json(405, { success: false, error: 'Method not allowed' });
        }

        // ------------------------------------------------------------
        // CACHE: one entry per (school, topic) pair. Caching per topic
        // keeps the payload small and lets us hit the cache even for
        // narrower queries like "school name" without doing a full read.
        // ------------------------------------------------------------
        const cacheKey = `school_info:${schoolId}:${topic}`;
        const cached = await cacheGet(cacheKey);
        if (cached) {
            return json(200, cached);
        }

        const admin = initAdmin();
        const db = admin.firestore();

        const [schoolSnap, teachersCountSnap, studentsCountSnap] = await Promise.all([
            db.collection('schools').doc(schoolId).get(),
            db.collection('teachers').where('schoolId', '==', schoolId).count().get().catch(() => null),
            db.collection('students').where('schoolId', '==', schoolId).count().get().catch(() => null),
        ]);

        if (!schoolSnap.exists) {
            return json(404, { success: false, error: 'School not found' });
        }

        const school = schoolSnap.data();
        const teacherCount = teachersCountSnap ? teachersCountSnap.data().count : null;
        const studentCount = studentsCountSnap ? studentsCountSnap.data().count : null;

        // Classes: prefer custom classes saved on the school doc.
        const customClasses = Array.isArray(school.customClasses)
            ? school.customClasses
                .map((c) => ({ level: c.level, className: c.className }))
                .filter((c) => c.level && c.className)
            : [];
        const useCustomClasses = !!school.useCustomClasses && customClasses.length > 0;

        // Subjects: derive the grouped map from `customSubjects` if present.
        const useCustomSubjects = !!school.useCustomSubjects;
        const subjectsByLevel = buildSubjectsByLevel(school);

        // Levels the school runs.
        const highestLevel = school.highestLevel || 'senior-school';
        const levels = resolveLevels(highestLevel);

        const summary = {
            overview: buildOverviewSummary(school, teacherCount, studentCount, levels, useCustomClasses, customClasses),
            classes: buildClassesSummary(useCustomClasses, customClasses, levels),
            subjects: buildSubjectsSummary(useCustomSubjects, subjectsByLevel, levels),
            teachers: teacherCount == null
                ? 'Teacher records aren\'t available right now.'
                : `There are ${teacherCount} registered teacher${teacherCount === 1 ? '' : 's'} on file.`,
            contact: buildContactSummary(school),
            levels: `The school runs these levels: ${levels.map((l) => LEVEL_LABELS[l]).join(', ')}.`,
        };

        let payload;

        if (topic === 'all') {
            payload = {
                success: true,
                topic,
                summary: summary.overview,
                data: {
                    school,
                    teacherCount,
                    studentCount,
                    levels,
                    classes: useCustomClasses ? customClasses : null,
                    subjects: subjectsByLevel,
                },
                summaries: summary,
            };
        } else if (!summary[topic]) {
            // Unknown topic — do not cache, it's a client bug.
            return json(400, { success: false, error: `Unknown topic "${topic}"` });
        } else {
            payload = {
                success: true,
                topic,
                summary: summary[topic],
                data: {
                    school,
                    teacherCount,
                    studentCount,
                    levels,
                    classes: useCustomClasses ? customClasses : null,
                    subjects: subjectsByLevel,
                },
            };
        }

        // Cache for 12 hours. Write failures are non-fatal.
        await cacheSet(cacheKey, payload, CACHE_TTL_SECONDS);

        return json(200, payload);
    } catch (err) {
        console.error('[chatbot-school-info]', err);
        return errorResponse(err);
    }
};

function buildOverviewSummary(school, teacherCount, studentCount, levels, useCustomClasses, customClasses) {
    const name = school.name || school.schoolName || 'the school';
    const parts = [];
    parts.push(`${name} is a ${describeType(school.schoolType)} running the ${describeCurriculum(school.curriculum)} curriculum.`);

    if (levels.length) {
        parts.push(`It offers ${levels.length} level${levels.length === 1 ? '' : 's'}: ${levels.map((l) => LEVEL_LABELS[l]).join(', ')}.`);
    }
    if (useCustomClasses) {
        parts.push(`There are ${customClasses.length} classes configured.`);
    }
    if (teacherCount != null) {
        parts.push(`Currently ${teacherCount} teacher${teacherCount === 1 ? '' : 's'} on the roster.`);
    }
    if (studentCount != null) {
        parts.push(`${studentCount} student${studentCount === 1 ? '' : 's'} enrolled.`);
    }
    if (school.motto) {
        parts.push(`Motto: "${school.motto}".`);
    }
    return parts.join(' ');
}

function buildClassesSummary(useCustomClasses, customClasses, levels) {
    if (useCustomClasses) {
        const grouped = {};
        customClasses.forEach((c) => {
            if (!grouped[c.level]) grouped[c.level] = [];
            grouped[c.level].push(c.className);
        });
        const lines = Object.entries(grouped).map(
            ([lvl, list]) => `• ${LEVEL_LABELS[lvl] || lvl}: ${list.join(', ')}`
        );
        return `Here are the classes in use:\n${lines.join('\n')}`;
    }
    const DEFAULTS = {
        'pre-primary': ['PP1', 'PP2'],
        'lower-primary': ['Grade 1', 'Grade 2', 'Grade 3'],
        'upper-primary': ['Grade 4', 'Grade 5', 'Grade 6'],
        'junior-school': ['Grade 7', 'Grade 8', 'Grade 9'],
        'senior-school': ['Grade 10', 'Grade 11', 'Grade 12'],
    };
    const lines = levels.map((lvl) => `• ${LEVEL_LABELS[lvl]}: ${(DEFAULTS[lvl] || []).join(', ')}`);
    return `The school uses the standard class structure:\n${lines.join('\n')}`;
}

function buildSubjectsSummary(useCustomSubjects, subjectsByLevel, levels) {
    const lines = [];
    for (const lvl of levels) {
        const list = subjectsByLevel[lvl] || [];
        if (list.length) lines.push(`• ${LEVEL_LABELS[lvl]}: ${list.join(', ')}`);
    }
    if (!lines.length) return 'Subjects are managed in the Timetable module.';
    const prefix = useCustomSubjects
        ? 'These are the school\'s custom subjects:'
        : 'The school offers the following subjects per level:';
    return `${prefix}\n${lines.join('\n')}`;
}

function buildContactSummary(school) {
    const parts = [];
    if (school.phone) parts.push(`Phone: ${school.phone}`);
    if (school.email) parts.push(`Email: ${school.email}`);
    if (school.address) parts.push(`Address: ${school.address}`);
    if (school.website) parts.push(`Website: ${school.website}`);
    if (school.schoolCode) parts.push(`School Code: ${school.schoolCode}`);
    if (!parts.length) return 'No contact details are on file yet.';
    return parts.join('\n');
}

function describeType(t) {
    const map = {
        primary: 'primary school',
        secondary: 'secondary school',
        combined: 'combined school',
        college: 'college',
        university: 'university',
    };
    return map[t] || 'school';
}

function describeCurriculum(c) {
    const map = {
        cbc: 'CBC (Competency-Based)',
        cbe: 'CBE',
        '8-4-4': '8-4-4',
        igcse: 'IGCSE',
        ib: 'International Baccalaureate',
    };
    return map[c] || 'national';
}
