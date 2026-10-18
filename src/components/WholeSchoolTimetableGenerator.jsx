import React, { useEffect, useMemo, useState } from 'react';
import {
    doc, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase';
import {
    classPeriodsForLevel, DAYS, periodsForLevel, buildClassKey,
    normalizeTerm, normalizeYear, saveTimetableSettings,
    teacherFullName, teacherInitials, TEACHER_MAX_LOAD,
} from '../services/timetableService';
import { generateTimetable, validateTimetable } from '../services/timetableEngine';
import { LEVEL_ORDER, LEVEL_SUBJECTS } from '../utils/constants';
import { AuditLogService } from '../services/auditService';
import './WholeSchoolTimetableGenerator.css';

const EMPTY_CONFIG = { allocations: [], rooms: [], unavailable: [], manualOverrides: [] };
const clockMinutes = (value) => {
    if (!/^\d{2}:\d{2}$/.test(String(value || ''))) return null;
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
};
const classKey = (level, cls) => `${level}::${cls}`;
const displayTeacherName = (teacher) => teacherFullName(teacher) || teacher.fullName || teacher.name || teacher.id;

function periodsForClass(level, customConfig) {
    return classPeriodsForLevel(level, customConfig).map((period) => ({
        ...period,
        id: `${level}__${period.id}`,
        sourcePeriodId: period.id,
        level,
    }));
}

export default function WholeSchoolTimetableGenerator({
    schoolId,
    userId,
    userData,
    userRole,
    currentUser,
    teachers = [],
    customConfig,
    getLevelClasses,
    term,
    year,
    notify,
    onSaved,
}) {
    const [config, setConfig] = useState(() => ({
        ...EMPTY_CONFIG,
        ...(customConfig?.wholeSchoolCsp || {}),
    }));
    const [level, setLevel] = useState(LEVEL_ORDER[0]);
    const [className, setClassName] = useState('');
    const [subjectId, setSubjectId] = useState('');
    const [weeklyLessons, setWeeklyLessons] = useState(1);
    const [doubleLessons, setDoubleLessons] = useState(0);
    const [teacherIds, setTeacherIds] = useState([]);
    const [roomIds, setRoomIds] = useState([]);
    const [requiresRoom, setRequiresRoom] = useState(false);
    const [roomId, setRoomId] = useState('');
    const [roomName, setRoomName] = useState('');
    const [blockKind, setBlockKind] = useState('teacher');
    const [blockEntityId, setBlockEntityId] = useState('');
    const [blockDay, setBlockDay] = useState(DAYS[0]);
    const [blockPeriodId, setBlockPeriodId] = useState('');
    const [manualClassId, setManualClassId] = useState('');
    const [manualSubjectId, setManualSubjectId] = useState('');
    const [manualDay, setManualDay] = useState(DAYS[0]);
    const [manualPeriodId, setManualPeriodId] = useState('');
    const [manualTeacherId, setManualTeacherId] = useState('');
    const [manualRoomId, setManualRoomId] = useState('');
    const [manualDouble, setManualDouble] = useState(false);
    const [savingConfig, setSavingConfig] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [lastResult, setLastResult] = useState(null);
    const [lastError, setLastError] = useState('');

    const schoolClasses = useMemo(() => LEVEL_ORDER.flatMap((schoolLevel) => (
        (getLevelClasses?.(schoolLevel) || []).map((name) => ({
            id: classKey(schoolLevel, name),
            level: schoolLevel,
            name,
        }))
    )), [getLevelClasses]);

    const periodsByClass = useMemo(() => Object.fromEntries(
        schoolClasses.map((schoolClass) => [
            schoolClass.id,
            periodsForClass(schoolClass.level, customConfig),
        ])
    ), [schoolClasses, customConfig]);

    const allPeriods = useMemo(() => {
        const map = new Map();
        LEVEL_ORDER.forEach((schoolLevel) => {
            periodsForLevel(schoolLevel, customConfig).forEach((period, index) => {
                const id = `${schoolLevel}__${period.id}`;
                const start = clockMinutes(period.start);
                const end = clockMinutes(period.end);
                map.set(id, {
                    id,
                    name: `${schoolLevel.replace(/-/g, ' ')} · ${period.name || period.label || period.id}`,
                    level: schoolLevel,
                    sourcePeriodId: period.id,
                    start: period.start,
                    end: period.end,
                    order: (start ?? index) * 100 + index,
                    type: period.type || 'class',
                });
            });
        });
        return [...map.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    }, [customConfig]);

    const subjectsForLevel = useMemo(
        () => customConfig?.subjectsByLevel?.[level] || LEVEL_SUBJECTS[level] || [],
        [customConfig, level]
    );

    const selectedClassId = classKey(level, className);
    const manualRequirement = config.allocations.find(
        (item) => item.classId === manualClassId && item.subjectId === manualSubjectId
    );
    const manualClassPeriods = periodsByClass[manualClassId] || [];
    const manualStartIndex = manualClassPeriods.findIndex((period) => period.id === manualPeriodId);
    const manualNextPeriod = manualStartIndex >= 0 ? manualClassPeriods[manualStartIndex + 1] : null;
    const isValidDoublePair = Boolean(
        manualNextPeriod
        && clockMinutes(manualClassPeriods[manualStartIndex]?.end) !== null
        && clockMinutes(manualClassPeriods[manualStartIndex]?.end) === clockMinutes(manualNextPeriod.start)
    );

    useEffect(() => {
        setConfig({
            ...EMPTY_CONFIG,
            ...(customConfig?.wholeSchoolCsp || {}),
        });
    }, [customConfig?.wholeSchoolCsp]);

    useEffect(() => {
        if (!className || !(getLevelClasses?.(level) || []).includes(className)) {
            setClassName((getLevelClasses?.(level) || [])[0] || '');
        }
    }, [className, level, getLevelClasses]);

    useEffect(() => {
        if (!subjectsForLevel.includes(subjectId)) setSubjectId(subjectsForLevel[0] || '');
    }, [subjectsForLevel, subjectId]);

    useEffect(() => {
        if (!manualClassId && schoolClasses.length) setManualClassId(schoolClasses[0].id);
        if (!manualTeacherId && teachers.length) setManualTeacherId(teachers[0].id);
    }, [manualClassId, manualTeacherId, schoolClasses, teachers]);

    const updateConfig = (field, value) => setConfig((previous) => ({ ...previous, [field]: value }));

    const addAllocation = () => {
        const weekly = Number(weeklyLessons);
        const doubles = Number(doubleLessons);
        if (!className || !subjectId || !Number.isInteger(weekly) || weekly < 1
            || !Number.isInteger(doubles) || doubles < 0 || doubles * 2 > weekly) {
            notify('Enter a class, learning area, valid weekly lesson count, and valid double count.', 'warning');
            return;
        }
        if (config.allocations.some((item) => item.classId === selectedClassId && item.subjectId === subjectId)) {
            notify('This class already has an allocation for that learning area. Remove it first to replace it.', 'warning');
            return;
        }
        updateConfig('allocations', [
            ...config.allocations,
            {
                id: `${selectedClassId}::${subjectId}`,
                classId: selectedClassId,
                level,
                className,
                subjectId,
                weeklyLessons: weekly,
                doubleLessons: doubles,
                teacherIds,
                roomIds,
                requiresRoom,
            },
        ]);
    };

    const addRoom = () => {
        const id = roomId.trim();
        const name = roomName.trim();
        if (!id || !name) {
            notify('Enter a room ID and display name.', 'warning');
            return;
        }
        if (config.rooms.some((room) => room.id === id)) {
            notify('That room ID already exists.', 'warning');
            return;
        }
        updateConfig('rooms', [...config.rooms, { id, name }]);
        setRoomId('');
        setRoomName('');
    };

    const blockEntities = blockKind === 'teacher'
        ? teachers.map((teacher) => ({ id: teacher.id, label: displayTeacherName(teacher) }))
        : blockKind === 'room'
            ? config.rooms.map((room) => ({ id: room.id, label: room.name }))
            : schoolClasses.map((schoolClass) => ({ id: schoolClass.id, label: `${schoolClass.level} · ${schoolClass.name}` }));

    useEffect(() => {
        if (!blockEntities.some((entity) => entity.id === blockEntityId)) {
            setBlockEntityId(blockEntities[0]?.id || '');
        }
    }, [blockEntities, blockEntityId]);

    const addUnavailability = () => {
        if (!blockEntityId || !blockPeriodId) {
            notify('Choose the resource and period to mark unavailable.', 'warning');
            return;
        }
        const duplicate = config.unavailable.some((entry) =>
            entry.kind === blockKind && entry.entityId === blockEntityId
            && entry.day === blockDay && entry.periodId === blockPeriodId
        );
        if (duplicate) return;
        updateConfig('unavailable', [
            ...config.unavailable,
            { kind: blockKind, entityId: blockEntityId, day: blockDay, periodId: blockPeriodId },
        ]);
    };

    const addManualOverride = () => {
        if (!manualClassId || !manualSubjectId || !manualPeriodId || !manualTeacherId) {
            notify('Choose a class, learning area, period, and teacher for the manual override.', 'warning');
            return;
        }
        const periodIds = [manualPeriodId];
        if (manualDouble) {
            if (!isValidDoublePair) {
                notify('A double lesson must use two adjacent class periods with no break between them.', 'warning');
                return;
            }
            periodIds.push(manualNextPeriod.id);
        }
        updateConfig('manualOverrides', [
            ...config.manualOverrides,
            {
                id: `manual-${Date.now()}`,
                classId: manualClassId,
                subjectId: manualSubjectId,
                day: manualDay,
                periodIds,
                teacherId: manualTeacherId,
                ...(manualRoomId ? { roomId: manualRoomId } : {}),
            },
        ]);
    };

    const saveConfiguration = async () => {
        if (!schoolId || savingConfig) return;
        setSavingConfig(true);
        try {
            await saveTimetableSettings(schoolId, { wholeSchoolCsp: config }, userId);
            await AuditLogService.logAction(
                schoolId,
                { uid: userId, fullName: userData?.fullName, email: currentUser?.email, role: userRole },
                'TIMETABLE_CONSTRAINTS_UPDATED',
                { message: 'Whole-school timetable allocations and constraints updated', allocationCount: config.allocations.length }
            );
            notify('Whole-school timetable configuration saved.', 'success');
        } catch (error) {
            console.error('[WholeSchoolTimetableGenerator] save config:', error);
            notify(`Could not save timetable configuration: ${error.message}`, 'error');
        } finally {
            setSavingConfig(false);
        }
    };

    const makeSolverInput = () => {
        const periodById = new Map(allPeriods.map((period) => [period.id, period]));
        const classes = schoolClasses.map((schoolClass) => {
            const classPeriods = periodsByClass[schoolClass.id] || [];
            const teachingIds = classPeriods.map((period) => period.id);
            const pairs = [];
            classPeriods.slice(0, -1).forEach((period, index) => {
                const next = classPeriods[index + 1];
                const end = clockMinutes(period.end);
                const start = clockMinutes(next.start);
                if (end !== null && end === start) pairs.push([period.id, next.id]);
            });
            const requirements = config.allocations
                .filter((allocation) => allocation.classId === schoolClass.id)
                .map((allocation) => ({
                    subjectId: allocation.subjectId,
                    weeklyLessons: Number(allocation.weeklyLessons),
                    doubleLessons: Number(allocation.doubleLessons) || 0,
                    teacherIds: allocation.teacherIds || [],
                    roomIds: allocation.roomIds || [],
                    requiresRoom: allocation.requiresRoom === true,
                    allowedPeriods: teachingIds,
                    consecutivePeriodPairs: pairs,
                }));
            const blocked = config.unavailable
                .filter((entry) => entry.kind === 'class' && entry.entityId === schoolClass.id)
                .map(({ day, periodId }) => ({ day, periodId }));
            return {
                id: schoolClass.id,
                level: schoolClass.level,
                name: schoolClass.name,
                unavailable: blocked,
                requirements,
            };
        });
        const allocationTeacherAssignments = new Map();
        config.allocations.forEach((allocation) => {
            (allocation.teacherIds || []).forEach((teacherId) => {
                const list = allocationTeacherAssignments.get(teacherId) || [];
                list.push({
                    subjectId: allocation.subjectId,
                    classIds: [allocation.classId],
                    level: allocation.level,
                });
                allocationTeacherAssignments.set(teacherId, list);
            });
        });
        const solverTeachers = teachers.map((teacher) => {
            const unavailable = [
                ...(Array.isArray(teacher.unavailable) ? teacher.unavailable : []),
                ...config.unavailable
                    .filter((entry) => entry.kind === 'teacher' && entry.entityId === teacher.id)
                    .map(({ day, periodId }) => ({ day, periodId })),
            ];
            const nativeSubjects = teacher.subjects || teacher.subjectIds || teacher.learningAreas
                || (teacher.subject ? [teacher.subject] : []);
            return {
                id: teacher.id,
                subjects: Array.isArray(nativeSubjects)
                    ? nativeSubjects
                    : (nativeSubjects ? [nativeSubjects] : []),
                assignments: Array.isArray(teacher.assignments) && teacher.assignments.length
                    ? teacher.assignments
                    : (allocationTeacherAssignments.get(teacher.id) || []),
                unavailable,
                maxLessons: Number(teacher.maxWeeklyLessons || teacher.maxLessons || teacher.weeklyLessonLimit)
                    || TEACHER_MAX_LOAD,
            };
        });
        const rooms = config.rooms.map((room) => ({
            ...room,
            subjects: room.subjects || [],
            unavailable: [
                ...(Array.isArray(room.unavailable) ? room.unavailable : []),
                ...config.unavailable
                    .filter((entry) => entry.kind === 'room' && entry.entityId === room.id)
                    .map(({ day, periodId }) => ({ day, periodId })),
            ],
        }));
        return {
            days: DAYS,
            periods: allPeriods,
            classes,
            teachers: solverTeachers,
            rooms,
            requireTeachers: true,
            requireRooms: false,
            manualOverrides: config.manualOverrides,
            periodById,
        };
    };

    const generate = async () => {
        if (!schoolId || generating) return;
        setGenerating(true);
        setLastResult(null);
        setLastError('');
        try {
            const input = makeSolverInput();
            const unconfigured = input.classes.filter((schoolClass) => schoolClass.requirements.length === 0);
            if (unconfigured.length) {
                throw new Error(`Add CBC learning-area allocations for every class first. Missing: ${unconfigured.map((item) => `${item.level} ${item.name}`).join(', ')}`);
            }
            const result = generateTimetable(input);
            setLastResult(result);
            if (result.status !== 'solved') {
                notify(`Timetable not saved: solver status is ${result.status}. Review the diagnostics below.`, 'warning');
                return;
            }
            const validation = validateTimetable(input, result.schedule);
            if (!validation.valid) {
                setLastResult({ ...result, status: 'invalid_schedule', diagnostics: { errors: validation.errors } });
                notify('The generated timetable failed validation and was not saved.', 'error');
                return;
            }
            if (input.classes.length > 450) {
                throw new Error('More than 450 class schedules exceed the safe atomic-save limit. Reduce the school class set before saving.');
            }
            if (!window.confirm(
                `Generate and replace the whole-school timetable for ${input.classes.length} classes, ${term}, ${year}?`
            )) return;

            const classById = new Map(input.classes.map((schoolClass) => [schoolClass.id, schoolClass]));
            const teacherById = new Map(input.teachers.map((teacher) => [teacher.id, teacher]));
            const roomById = new Map(input.rooms.map((room) => [room.id, room]));
            const schedules = new Map(input.classes.map((schoolClass) => [schoolClass.id, {}]));
            for (const assignment of result.schedule.assignments) {
                const target = schedules.get(assignment.classId);
                const assignedTeacher = teacherById.get(assignment.teacherId);
                const assignedRoom = roomById.get(assignment.roomId);
                for (const internalPeriodId of assignment.periodIds) {
                    const period = input.periodById.get(internalPeriodId);
                    if (!period) throw new Error(`Generated assignment has an unknown period: ${internalPeriodId}`);
                    target[assignment.day] ||= {};
                    target[assignment.day][period.sourcePeriodId] = {
                        subject: assignment.subjectId,
                        teacherId: assignment.teacherId || '',
                        teacherInitials: assignedTeacher ? teacherInitials(assignedTeacher) : '',
                        teacherFullName: assignedTeacher ? displayTeacherName(assignedTeacher) : '',
                        room: assignedRoom?.name || '',
                        isManualOverride: assignment.source === 'manual',
                    };
                }
            }
            const batch = writeBatch(db);
            input.classes.forEach((schoolClass) => {
                const target = classById.get(schoolClass.id);
                batch.set(doc(db, 'school_timetables', buildClassKey(schoolId, target.level, target.name, term, year)), {
                    schoolId,
                    level: target.level,
                    class: target.name,
                    term: normalizeTerm(term),
                    year: normalizeYear(year),
                    schedule: schedules.get(schoolClass.id),
                    updatedAt: serverTimestamp(),
                    updatedBy: userId || 'admin',
                    generationSchemaVersion: result.schedule.schemaVersion,
                }, { merge: true });
            });
            await batch.commit();
            await AuditLogService.logAction(
                schoolId,
                { uid: userId, fullName: userData?.fullName, email: currentUser?.email, role: userRole },
                'TIMETABLE_GENERATED',
                {
                    message: `Whole-school clash-free timetable generated for ${input.classes.length} classes`,
                    term,
                    year,
                    classCount: input.classes.length,
                    lessonCount: result.schedule.assignments.length,
                    backtracks: result.stats.backtracks,
                }
            );
            notify(`Whole-school timetable saved for ${input.classes.length} classes.`, 'success');
            onSaved?.();
        } catch (error) {
            console.error('[WholeSchoolTimetableGenerator] generate:', error);
            setLastError(error.message);
            notify(error.message || 'Whole-school timetable generation failed.', 'error');
        } finally {
            setGenerating(false);
        }
    };

    const manualSubjects = config.allocations.filter((allocation) => allocation.classId === manualClassId);
    const selectedManualAllocation = manualSubjects.find((allocation) => allocation.subjectId === manualSubjectId);
    const eligibleManualTeachers = selectedManualAllocation?.teacherIds?.length
        ? teachers.filter((teacher) => selectedManualAllocation.teacherIds.includes(teacher.id))
        : teachers;

    return (
        <section className="tt-csp">
            <header className="tt-csp-header">
                <div>
                    <h2>Whole-school constraint solver</h2>
                    <p>Configure the school-approved CBC lesson allocations, teacher/room availability, and pinned manual lessons. No lesson quotas are guessed by the app.</p>
                </div>
                <div className="tt-csp-header-actions">
                    <button type="button" className="btn btn-outline" onClick={saveConfiguration} disabled={savingConfig || generating}>
                        {savingConfig ? 'Saving...' : 'Save configuration'}
                    </button>
                    <button type="button" className="btn btn-primary" onClick={generate} disabled={generating || !schoolClasses.length || !teachers.length}>
                        {generating ? 'Solving...' : 'Generate whole school'}
                    </button>
                </div>
            </header>

            <div className="tt-csp-warning" role="note">
                Configure lesson counts from the school’s approved CBC timetable plan. The generator saves only a complete validated schedule; unsatisfied constraints leave existing timetables unchanged.
            </div>
            {lastError && <div className="tt-csp-error" role="alert">{lastError}</div>}

            <section className="tt-csp-card">
                <h3>Weekly learning-area allocations</h3>
                <div className="tt-csp-form-grid">
                    <label>Level
                        <select value={level} onChange={(event) => { setLevel(event.target.value); setClassName(''); }}>
                            {LEVEL_ORDER.map((item) => <option key={item} value={item}>{item.replace(/-/g, ' ')}</option>)}
                        </select>
                    </label>
                    <label>Class
                        <select value={className} onChange={(event) => setClassName(event.target.value)}>
                            {(getLevelClasses?.(level) || []).map((item) => <option key={item} value={item}>{item}</option>)}
                        </select>
                    </label>
                    <label>Learning area
                        <select value={subjectId} onChange={(event) => setSubjectId(event.target.value)}>
                            {subjectsForLevel.map((item) => <option key={item} value={item}>{item}</option>)}
                        </select>
                    </label>
                    <label>Lessons per week
                        <input type="number" min="1" step="1" value={weeklyLessons}
                            onChange={(event) => setWeeklyLessons(event.target.value)} />
                    </label>
                    <label>Double lessons
                        <input type="number" min="0" step="1" value={doubleLessons}
                            onChange={(event) => setDoubleLessons(event.target.value)} />
                    </label>
                    <label>Qualified teachers (optional)
                        <select multiple value={teacherIds} onChange={(event) => setTeacherIds(
                            [...event.target.selectedOptions].map((option) => option.value)
                        )}>
                            {teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{displayTeacherName(teacher)}</option>)}
                        </select>
                    </label>
                    <label>Allowed rooms (optional)
                        <select multiple value={roomIds} onChange={(event) => setRoomIds(
                            [...event.target.selectedOptions].map((option) => option.value)
                        )}>
                            {config.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                        </select>
                    </label>
                    <label className="tt-csp-checkbox">
                        <input type="checkbox" checked={requiresRoom} onChange={(event) => setRequiresRoom(event.target.checked)} />
                        This learning area requires a room
                    </label>
                </div>
                <button type="button" className="btn btn-outline" onClick={addAllocation}>Add allocation</button>
                <div className="tt-csp-table-wrap">
                    <table className="tt-csp-table">
                        <thead><tr><th>Level / class</th><th>Learning area</th><th>Lessons</th><th>Doubles</th><th>Teachers</th><th>Rooms</th><th></th></tr></thead>
                        <tbody>
                            {config.allocations.map((allocation) => (
                                <tr key={allocation.id}>
                                    <td>{allocation.level} · {allocation.className}</td>
                                    <td>{allocation.subjectId}</td>
                                    <td>{allocation.weeklyLessons}</td>
                                    <td>{allocation.doubleLessons || 0}</td>
                                    <td>{allocation.teacherIds?.length ? allocation.teacherIds.map((id) => displayTeacherName(teachers.find((teacher) => teacher.id === id) || { id })).join(', ') : 'Auto-assign'}</td>
                                    <td>{allocation.roomIds?.length ? allocation.roomIds.map((id) => config.rooms.find((room) => room.id === id)?.name || id).join(', ') : (allocation.requiresRoom ? 'Required' : 'No restriction')}</td>
                                    <td><button type="button" className="tt-csp-remove" onClick={() => updateConfig('allocations', config.allocations.filter((item) => item.id !== allocation.id))}>Remove</button></td>
                                </tr>
                            ))}
                            {!config.allocations.length && <tr><td colSpan="7">No allocations configured yet.</td></tr>}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="tt-csp-card">
                <h3>Rooms and specialist spaces</h3>
                <div className="tt-csp-inline-form">
                    <label>Room ID<input value={roomId} onChange={(event) => setRoomId(event.target.value)} maxLength={64} /></label>
                    <label>Room name<input value={roomName} onChange={(event) => setRoomName(event.target.value)} maxLength={80} /></label>
                    <button type="button" className="btn btn-outline" onClick={addRoom}>Add room</button>
                </div>
                <div className="tt-csp-chip-list">
                    {config.rooms.map((room) => (
                        <span className="tt-csp-chip" key={room.id}>{room.name} <small>({room.id})</small>
                            <button type="button" aria-label={`Remove ${room.name}`} onClick={() => {
                                updateConfig('rooms', config.rooms.filter((item) => item.id !== room.id));
                                updateConfig('allocations', config.allocations.map((allocation) => ({
                                    ...allocation,
                                    roomIds: (allocation.roomIds || []).filter((id) => id !== room.id),
                                })));
                            }}>×</button>
                        </span>
                    ))}
                    {!config.rooms.length && <span>No rooms configured; rooms are optional unless required by a learning-area allocation.</span>}
                </div>
            </section>

            <section className="tt-csp-card">
                <h3>Teacher, class, and room unavailability</h3>
                <div className="tt-csp-form-grid">
                    <label>Resource
                        <select value={blockKind} onChange={(event) => { setBlockKind(event.target.value); setBlockEntityId(''); }}>
                            <option value="teacher">Teacher</option><option value="class">Class</option><option value="room">Room</option>
                        </select>
                    </label>
                    <label>Person / room / class
                        <select value={blockEntityId} onChange={(event) => setBlockEntityId(event.target.value)}>
                            {blockEntities.map((entity) => <option key={entity.id} value={entity.id}>{entity.label}</option>)}
                        </select>
                    </label>
                    <label>Day
                        <select value={blockDay} onChange={(event) => setBlockDay(event.target.value)}>
                            {DAYS.map((day) => <option key={day}>{day}</option>)}
                        </select>
                    </label>
                    <label>Level period
                        <select value={blockPeriodId} onChange={(event) => setBlockPeriodId(event.target.value)}>
                            {allPeriods.filter((period) => period.type === 'class').map((period) => (
                                <option key={period.id} value={period.id}>{period.name} · {period.start}–{period.end}</option>
                            ))}
                        </select>
                    </label>
                </div>
                <button type="button" className="btn btn-outline" onClick={addUnavailability}>Mark unavailable</button>
                <ul className="tt-csp-block-list">
                    {config.unavailable.map((entry, index) => {
                        const label = entry.kind === 'teacher'
                            ? displayTeacherName(teachers.find((item) => item.id === entry.entityId) || { id: entry.entityId })
                            : entry.kind === 'class'
                                ? schoolClasses.find((item) => item.id === entry.entityId)?.name || entry.entityId
                                : config.rooms.find((item) => item.id === entry.entityId)?.name || entry.entityId;
                        const period = allPeriods.find((item) => item.id === entry.periodId);
                        return (
                            <li key={`${entry.kind}-${entry.entityId}-${entry.day}-${entry.periodId}`}>
                                {entry.kind}: {label} · {entry.day} · {period?.name || entry.periodId}
                                <button type="button" onClick={() => updateConfig('unavailable', config.unavailable.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
                            </li>
                        );
                    })}
                    {!config.unavailable.length && <li>No unavailable periods configured.</li>}
                </ul>
            </section>

            <section className="tt-csp-card">
                <h3>Manual overrides</h3>
                <p>Pinned lessons are validated first and held fixed while the solver fills the remaining allocations.</p>
                <div className="tt-csp-form-grid">
                    <label>Class
                        <select value={manualClassId} onChange={(event) => {
                            setManualClassId(event.target.value);
                            setManualSubjectId('');
                            setManualPeriodId('');
                        }}>
                            {schoolClasses.map((item) => <option key={item.id} value={item.id}>{item.level} · {item.name}</option>)}
                        </select>
                    </label>
                    <label>Learning area
                        <select value={manualSubjectId} onChange={(event) => setManualSubjectId(event.target.value)}>
                            <option value="">Select allocation</option>
                            {manualSubjects.map((allocation) => <option key={allocation.subjectId} value={allocation.subjectId}>{allocation.subjectId}</option>)}
                        </select>
                    </label>
                    <label>Day
                        <select value={manualDay} onChange={(event) => setManualDay(event.target.value)}>
                            {DAYS.map((day) => <option key={day}>{day}</option>)}
                        </select>
                    </label>
                    <label>First period
                        <select value={manualPeriodId} onChange={(event) => setManualPeriodId(event.target.value)}>
                            {manualClassPeriods.map((period) => <option key={period.id} value={period.id}>{period.name} · {period.start}–{period.end}</option>)}
                        </select>
                    </label>
                    <label>Teacher
                        <select value={manualTeacherId} onChange={(event) => setManualTeacherId(event.target.value)}>
                            <option value="">Select teacher</option>
                            {eligibleManualTeachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{displayTeacherName(teacher)}</option>)}
                        </select>
                    </label>
                    <label>Room
                        <select value={manualRoomId} onChange={(event) => setManualRoomId(event.target.value)}>
                            <option value="">No room</option>
                            {(selectedManualAllocation?.roomIds?.length
                                ? config.rooms.filter((room) => selectedManualAllocation.roomIds.includes(room.id))
                                : config.rooms).map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                        </select>
                    </label>
                    <label className="tt-csp-checkbox">
                        <input type="checkbox" checked={manualDouble} disabled={!isValidDoublePair}
                            onChange={(event) => setManualDouble(event.target.checked)} />
                        Pin as a consecutive double lesson
                    </label>
                </div>
                <button type="button" className="btn btn-outline" onClick={addManualOverride}>Add manual override</button>
                <div className="tt-csp-chip-list">
                    {config.manualOverrides.map((override, index) => (
                        <span className="tt-csp-chip" key={override.id || index}>
                            {schoolClasses.find((item) => item.id === override.classId)?.name || override.classId}
                            · {override.subjectId} · {override.day} · {override.periodIds.join('+')}
                            <button type="button" aria-label="Remove manual override"
                                onClick={() => updateConfig('manualOverrides', config.manualOverrides.filter((_, itemIndex) => itemIndex !== index))}>×</button>
                        </span>
                    ))}
                    {!config.manualOverrides.length && <span>No manual lessons pinned.</span>}
                </div>
            </section>

            {lastResult && (
                <section className="tt-csp-card" aria-live="polite">
                    <h3>Solver diagnostics: {lastResult.status}</h3>
                    <p>{lastResult.schedule?.assignments?.length || 0} lesson block(s) placed · {lastResult.stats?.nodes || 0} search node(s) · {lastResult.stats?.backtracks || 0} backtrack(s).</p>
                    {(lastResult.diagnostics?.errors || []).map((item, index) => (
                        <div className="tt-csp-error" key={`error-${index}`}>{item.message}</div>
                    ))}
                    {(lastResult.diagnostics?.blockers || []).map((item, index) => (
                        <div className="tt-csp-error" key={`blocker-${index}`}>{item.message} ({item.classId} · {item.subjectId})</div>
                    ))}
                    {(lastResult.diagnostics?.unsatisfied || []).map((item, index) => (
                        <div className="tt-csp-warning" key={`unsatisfied-${index}`}>
                            {schoolClasses.find((schoolClass) => schoolClass.id === item.classId)?.name || item.classId}
                            · {item.subjectId}: {item.remainingPeriods} lesson period(s) unscheduled
                            {item.reason?.message ? ` — ${item.reason.message}` : ''}
                        </div>
                    ))}
                </section>
            )}
            <small className="tt-csp-footnote">{config.allocations.length} allocation(s) · {config.rooms.length} room(s) · {config.manualOverrides.length} manual override(s)</small>
        </section>
    );
}
