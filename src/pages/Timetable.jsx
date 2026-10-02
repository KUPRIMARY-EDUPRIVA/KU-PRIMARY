// src/pages/Timetable.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSchool } from '../context/SchoolContext';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import { SCHOOL_LEVELS, LEVEL_SUBJECTS } from '../utils/constants';
import {
  DAYS, DUTY_AREAS, SUBJECT_CLASS,
  DEFAULT_PERIOD_STRUCTURES,
  periodsForLevel, classPeriodsForLevel, breakPeriodsForLevel,
  normalizeTerm, normalizeYear,
  teacherInitials, teacherFullName, safeSlug, fmtTime,
  calcDuration, formatPeriodTime,
  generateClassSchedule, detectClashes, detectDutyClashes,
  generateDutyRoster,
  summarizeTeacherLoad, summarizeClassCoverage,
  loadSchoolAndTeachers, loadClassTimetable, loadAllSchedulesForLevel,
  loadDutyRoster, saveClassTimetable, saveManyClassTimetables,
  saveDutyRoster,
  loadTimetableSettings, saveTimetableSettings,
  loadEvents, saveEvent, deleteEvent,
  // ── new ──
  getTeacherClassScope,
  summarizeTeacherLoadForTeacher,
} from '../services/timetableService';
import {
  downloadClassTimetablePDF,
  downloadTeacherTimetablePDF,
  downloadMasterTimetablePDF,
  downloadDutyRosterPDF,
} from '../services/timetablePdfClient';

const TABS = [
  { id: 'class',    label: 'Class Timetable',    icon: 'fa-calendar-days' },
  { id: 'teachers', label: 'Teacher Timetables', icon: 'fa-chalkboard-user' },
  { id: 'master',   label: 'Master Overview',    icon: 'fa-layer-group' },
  { id: 'duty',     label: 'Duty Roster',        icon: 'fa-clipboard-list' },
  { id: 'events',   label: 'Events & Activities',icon: 'fa-calendar-check' },
  { id: 'settings', label: 'Settings',           icon: 'fa-cog' },
];

const EVENT_COLORS = ['#d4a017', '#1e3a8a', '#059669', '#dc2626', '#7c3aed', '#0891b2'];

const ADMIN_ROLES = ['admin', 'school_admin', 'super-admin', 'user'];

export default function Timetable() {
  const { currentUser, userData, userRole } = useAuth();
  const { getLevelClasses } = useSchool();

  const schoolId = userData?.schoolId;
  const role = userRole || userData?.role || 'user';
  const isAdmin = ADMIN_ROLES.includes(role);
  const isTeacher = role === 'teacher';

  // ── Teacher scope ──
  // List of classes the current teacher is allowed to see. Empty for
  // admins (they see everything).
  const teacherClassScope = useMemo(
    () => (isTeacher ? getTeacherClassScope(userData) : []),
    [isTeacher, userData]
  );

  const [activeTab, setActiveTab] = useState(isTeacher ? 'class' : 'class');
  const [selectedLevel, setSelectedLevel] = useState('lower-primary');
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedTerm, setSelectedTerm] = useState('Term 1');
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  const [teachers, setTeachers] = useState([]);
  const [schoolInfo, setSchoolInfo] = useState(null);
  const [customConfig, setCustomConfig] = useState(null);
  const [events, setEvents] = useState([]);

  const [classSchedule, setClassSchedule] = useState({});
  const [classDirty, setClassDirty] = useState(false);
  const [classLoading, setClassLoading] = useState(false);

  const [allSchedules, setAllSchedules] = useState({});
  const [allLoaded, setAllLoaded] = useState(false);

  const [dutyRoster, setDutyRoster] = useState({});
  const [dutyDirty, setDutyDirty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [feedback, setFeedback] = useState({ message: '', type: '' });
  const [showSlotModal, setShowSlotModal] = useState(false);
  const [editingSlot, setEditingSlot] = useState(null);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showEventModal, setShowEventModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [lastUnassigned, setLastUnassigned] = useState([]);
  const [showPeriodEditor, setShowPeriodEditor] = useState(false);
  const [editingPeriod, setEditingPeriod] = useState(null);
  const [newSubject, setNewSubject] = useState('');
  const [newDutyArea, setNewDutyArea] = useState({ label: '', start: '08:00', end: '09:00' });

  const printRef = useRef(null);

  /* ---------------- Derived config ---------------- */

  const periods = useMemo(
    () => periodsForLevel(selectedLevel, customConfig),
    [selectedLevel, customConfig]
  );
  const classPeriods = useMemo(
    () => classPeriodsForLevel(selectedLevel, customConfig),
    [selectedLevel, customConfig]
  );

  // All classes available at the selected level.
  const levelClasses = useMemo(() => {
    if (!selectedLevel || !getLevelClasses) return [];
    try { return getLevelClasses(selectedLevel) || []; } catch { return []; }
  }, [selectedLevel, getLevelClasses]);

  // What the current user is allowed to see at the selected level.
  // Admin: every class. Teacher: intersection of levelClasses and
  // teacherClassScope.
  const availableClasses = useMemo(() => {
    if (!isTeacher) return levelClasses;
    if (teacherClassScope.length === 0) return [];
    const allow = new Set(teacherClassScope);
    const filtered = levelClasses.filter((c) => allow.has(c));
    // If the school's class list doesn't include the teacher's class
    // (e.g. custom class not yet registered), still surface it.
    const extras = teacherClassScope.filter((c) => !levelClasses.includes(c));
    return [...filtered, ...extras];
  }, [isTeacher, levelClasses, teacherClassScope]);

  const availableSubjects = useMemo(
    () => customConfig?.subjectsByLevel?.[selectedLevel]
      || LEVEL_SUBJECTS[selectedLevel]
      || ['Mathematics', 'English', 'Kiswahili', 'Science', 'Social Studies'],
    [selectedLevel, customConfig]
  );

  useEffect(() => {
    if (availableClasses.length && !availableClasses.includes(selectedClass)) {
      setSelectedClass(availableClasses[0]);
    }
    if (availableClasses.length === 0) {
      setSelectedClass('');
    }
  }, [availableClasses, selectedClass]);

  /* ---------------- Feedback ---------------- */

  const notify = useCallback((message, type = 'success') => {
    setFeedback({ message, type });
    const t = setTimeout(() => setFeedback({ message: '', type: '' }), 4200);
    return () => clearTimeout(t);
  }, []);

  /* ---------------- Bootstrap ---------------- */

  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    (async () => {
      try {
        const [schoolResult, settings] = await Promise.all([
          loadSchoolAndTeachers(schoolId),
          loadTimetableSettings(schoolId),
        ]);
        if (cancelled) return;
        setSchoolInfo(schoolResult.school);
        setTeachers(schoolResult.teachers);
        setCustomConfig(settings);
      } catch (err) {
        console.error('[Timetable] load school/teachers:', err);
        notify('Failed to load school data: ' + err.message, 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [schoolId, notify]);

  /* ---------------- Class timetable ---------------- */

  const reloadClass = useCallback(async () => {
    if (!schoolId || !selectedLevel || !selectedClass) {
      setClassSchedule({});
      return;
    }

    // Teacher guard: don't load a class they don't own.
    if (isTeacher && !teacherClassScope.includes(selectedClass)) {
      setClassSchedule({});
      return;
    }

    setClassLoading(true);
    try {
      const schedule = await loadClassTimetable(
        schoolId, selectedLevel, selectedClass, selectedTerm, selectedYear
      );
      setClassSchedule(schedule);
      setClassDirty(false);
    } catch (err) {
      console.error('[Timetable] load class:', err);
      notify('Failed to load timetable: ' + err.message, 'error');
    } finally {
      setClassLoading(false);
    }
  }, [
    schoolId, selectedLevel, selectedClass, selectedTerm, selectedYear,
    isTeacher, teacherClassScope, notify,
  ]);

  useEffect(() => { reloadClass(); }, [reloadClass]);

  /* ---------------- All schedules ---------------- */

  const reloadAll = useCallback(async () => {
    if (!schoolId || !selectedLevel) return;
    try {
      const result = await loadAllSchedulesForLevel(
        schoolId, selectedLevel, selectedTerm, selectedYear
      );

      // If the user is a teacher, restrict to their classes.
      let scoped = result;
      if (isTeacher) {
        const allow = new Set(teacherClassScope);
        scoped = {};
        for (const [cls, sched] of Object.entries(result)) {
          if (allow.has(cls)) scoped[cls] = sched;
        }
      }

      setAllSchedules(scoped);
      setAllLoaded(true);
    } catch (err) {
      console.error('[Timetable] load all:', err);
      notify('Failed to load class schedules: ' + err.message, 'error');
    }
  }, [
    schoolId, selectedLevel, selectedTerm, selectedYear,
    isTeacher, teacherClassScope, notify,
  ]);

  useEffect(() => {
    if (activeTab === 'teachers' || activeTab === 'master' || activeTab === 'class') {
      reloadAll();
    }
  }, [activeTab, reloadAll]);

  /* ---------------- Duty roster ---------------- */

  useEffect(() => {
    if (activeTab !== 'duty' || !schoolId) return;
    (async () => {
      try {
        const roster = await loadDutyRoster(schoolId, selectedTerm, selectedYear);
        setDutyRoster(roster);
        setDutyDirty(false);
      } catch (err) {
        console.error('[Timetable] load duty:', err);
        notify('Failed to load duty roster: ' + err.message, 'error');
      }
    })();
  }, [activeTab, schoolId, selectedTerm, selectedYear, notify]);

  /* ---------------- Events ---------------- */

  useEffect(() => {
    if (activeTab !== 'events' || !schoolId) return;
    (async () => {
      try {
        const list = await loadEvents(schoolId, selectedTerm, selectedYear);
        setEvents(list);
      } catch (err) {
        console.error('[Timetable] load events:', err);
        notify('Failed to load events: ' + err.message, 'error');
      }
    })();
  }, [activeTab, schoolId, selectedTerm, selectedYear, notify]);

  /* ---------------- Clash counts ---------------- */

  const classClashes = useMemo(
    () => detectClashes(selectedLevel, selectedClass, classSchedule, allSchedules, customConfig),
    [selectedLevel, selectedClass, classSchedule, allSchedules, customConfig]
  );

  const dutyClashes = useMemo(
    () => detectDutyClashes(dutyRoster, customConfig?.dutyAreas || DUTY_AREAS),
    [dutyRoster, customConfig]
  );

  /* ---------------- Teacher's own load ---------------- */

  // When the current user is a teacher, compute their weekly load from
  // the schedules they can see.
  const myTeacherLoad = useMemo(() => {
    if (!isTeacher || !currentUser?.uid) return null;
    return summarizeTeacherLoadForTeacher(
      allSchedules,
      currentUser.uid,
      selectedLevel,
      customConfig
    );
  }, [isTeacher, currentUser?.uid, allSchedules, selectedLevel, customConfig]);

  /* ---------------- Generation (admin only) ---------------- */

  const generateForCurrentClass = () => {
    if (!isAdmin) return;
    if (!teachers.length) {
      notify('Add teachers before generating.', 'warning');
      return;
    }
    setGenerating(true);
    try {
      const existingLoad = buildExistingTeacherLoad(allSchedules, selectedLevel, customConfig);
      const { schedule, unassigned } = generateClassSchedule({
        level: selectedLevel,
        cls: selectedClass,
        subjects: availableSubjects,
        teachers,
        otherSchedules: allSchedules,
        existingTeacherLoad: existingLoad,
        customConfig,
        events,
      });
      setClassSchedule(schedule);
      setClassDirty(true);
      setLastUnassigned(unassigned);
      if (unassigned.length) {
        notify(`Generated with ${unassigned.length} unfilled slot${unassigned.length === 1 ? '' : 's'}.`, 'warning');
      } else {
        notify('Timetable generated. Review, then Save.', 'success');
      }
    } catch (err) {
      console.error('[Timetable] generate:', err);
      notify('Failed to generate: ' + err.message, 'error');
    } finally {
      setGenerating(false);
    }
  };

  const generateForAllClasses = async () => {
    if (!isAdmin) return;
    if (!teachers.length) {
      notify('Add teachers first.', 'warning');
      return;
    }
    setBulkGenerating(true);
    try {
      const workingAll = { ...allSchedules };
      const newAll = { ...allSchedules };
      let totalUnassigned = 0;

      for (const cls of availableClasses) {
        const existingLoad = buildExistingTeacherLoad(workingAll, selectedLevel, customConfig);
        const { schedule, unassigned } = generateClassSchedule({
          level: selectedLevel,
          cls,
          subjects: availableSubjects,
          teachers,
          otherSchedules: workingAll,
          existingTeacherLoad: existingLoad,
          customConfig,
          events,
        });
        newAll[cls] = schedule;
        workingAll[cls] = schedule;
        totalUnassigned += unassigned.length;
      }

      await saveManyClassTimetables(
        schoolId, selectedLevel, selectedTerm, selectedYear, newAll, currentUser?.uid
      );

      setAllSchedules(newAll);
      setClassSchedule(newAll[selectedClass] || {});
      setClassDirty(false);
      setShowBulkModal(false);
      notify(
        `Generated ${availableClasses.length} timetable${availableClasses.length === 1 ? '' : 's'}` +
        (totalUnassigned ? ` (${totalUnassigned} unfilled slots)` : ''),
        totalUnassigned ? 'warning' : 'success'
      );
    } catch (err) {
      console.error('[Timetable] bulk generate:', err);
      notify('Bulk generation failed: ' + err.message, 'error');
    } finally {
      setBulkGenerating(false);
    }
  };

  const generateDuty = () => {
    if (!isAdmin) return;
    if (!teachers.length) {
      notify('Add teachers first.', 'warning');
      return;
    }
    const roster = generateDutyRoster(teachers, customConfig?.dutyAreas || DUTY_AREAS);
    setDutyRoster(roster);
    setDutyDirty(true);
    notify('Duty roster generated. Review, then Save.', 'success');
  };

  /* ---------------- Slot editor (admin only) ---------------- */

  const openSlotEditor = (day, periodId) => {
    if (!isAdmin) return;
    const current = classSchedule[day]?.[periodId] || {
      subject: '', teacherId: '', teacherInitials: '', teacherFullName: '',
      room: `${selectedClass} Room`,
    };
    setEditingSlot({ day, periodId, ...current });
    setShowSlotModal(true);
  };

  const saveSlot = (e) => {
    e.preventDefault();
    if (!isAdmin) return;
    if (!editingSlot) return;
    const { day, periodId, subject, teacherId, room } = editingSlot;
    if (!subject) { notify('Choose a subject.', 'warning'); return; }

    if (teacherId) {
      for (const [otherCls, sched] of Object.entries(allSchedules)) {
        if (otherCls === selectedClass) continue;
        const other = sched?.[day]?.[periodId];
        if (other?.teacherId === teacherId) {
          const ok = window.confirm(
            `Conflict: ${other.teacherFullName || other.teacherInitials} is already teaching ` +
            `${other.subject} in ${otherCls} at this time. Save anyway?`
          );
          if (!ok) return;
        }
      }
    }

    const teacher = teachers.find((t) => t.id === teacherId);
    const newSlot = {
      subject,
      teacherId: teacherId || '',
      teacherInitials: teacher ? teacherInitials(teacher) : 'TBA',
      teacherFullName: teacher ? teacherFullName(teacher) : '',
      room: room || `${selectedClass} Room`,
    };

    setClassSchedule((prev) => ({
      ...prev,
      [day]: { ...(prev[day] || {}), [periodId]: newSlot },
    }));
    setClassDirty(true);
    setShowSlotModal(false);
    setEditingSlot(null);
  };

  const clearSlot = (day, periodId) => {
    if (!isAdmin) return;
    setClassSchedule((prev) => {
      const copy = { ...prev, [day]: { ...(prev[day] || {}) } };
      delete copy[day][periodId];
      return copy;
    });
    setClassDirty(true);
  };

  const assignDuty = (day, areaId, teacherId) => {
    if (!isAdmin) return;
    const teacher = teachers.find((t) => t.id === teacherId);
    const area = (customConfig?.dutyAreas || DUTY_AREAS).find((a) => a.id === areaId);
    setDutyRoster((prev) => ({
      ...prev,
      [day]: {
        ...(prev[day] || {}),
        [areaId]: teacherId
          ? {
              teacherId,
              teacherInitials: teacherInitials(teacher),
              teacherFullName: teacherFullName(teacher),
              area,
            }
          : null,
      },
    }));
    setDutyDirty(true);
  };

  /* ---------------- Save (admin only) ---------------- */

  const saveCurrentClass = async () => {
    if (!isAdmin) return;
    if (!schoolId || !selectedClass) return;
    setSaving(true);
    try {
      if (classClashes.length > 0) {
        const ok = window.confirm(
          `Warning: ${classClashes.length} teacher clash${classClashes.length === 1 ? '' : 'es'} detected. Save anyway?`
        );
        if (!ok) { setSaving(false); return; }
      }
      await saveClassTimetable(
        schoolId, selectedLevel, selectedClass, selectedTerm, selectedYear,
        classSchedule, currentUser?.uid
      );
      setClassDirty(false);
      setAllSchedules((prev) => ({ ...prev, [selectedClass]: classSchedule }));
      notify('Timetable saved.', 'success');
    } catch (err) {
      console.error('[Timetable] save class:', err);
      notify('Failed to save: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveDuty = async () => {
    if (!isAdmin) return;
    if (!schoolId) return;
    setSaving(true);
    try {
      if (dutyClashes.length > 0) {
        const ok = window.confirm(
          `Warning: ${dutyClashes.length} duty clash${dutyClashes.length === 1 ? '' : 'es'} detected. Save anyway?`
        );
        if (!ok) { setSaving(false); return; }
      }
      await saveDutyRoster(schoolId, selectedTerm, selectedYear, dutyRoster, currentUser?.uid);
      setDutyDirty(false);
      notify('Duty roster saved.', 'success');
    } catch (err) {
      console.error('[Timetable] save duty:', err);
      notify('Failed to save duty roster: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async (newConfig) => {
    if (!isAdmin) return;
    if (!schoolId) return;
    setSaving(true);
    try {
      await saveTimetableSettings(schoolId, newConfig, currentUser?.uid);
      setCustomConfig(newConfig);
      notify('Settings saved.', 'success');
    } catch (err) {
      console.error('[Timetable] save settings:', err);
      notify('Failed to save settings: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const updateDutyAreas = (transform) => {
    if (!isAdmin) return;
    setCustomConfig((current) => ({
      ...(current || {}),
      dutyAreas: transform([...(current?.dutyAreas || DUTY_AREAS)]),
    }));
  };

  const updateDutyArea = (areaId, updates) => {
    if (!isAdmin) return;
    updateDutyAreas((areas) => areas.map((area) => (
      area.id === areaId ? { ...area, ...updates } : area
    )));
  };

  const removeDutyArea = (areaId) => {
    if (!isAdmin) return;
    updateDutyAreas((areas) => areas.filter((area) => area.id !== areaId));
    setDutyRoster((current) => Object.fromEntries(
      Object.entries(current).map(([day, assignments]) => {
        const updatedAssignments = { ...assignments };
        delete updatedAssignments[areaId];
        return [day, updatedAssignments];
      })
    ));
    setDutyDirty(true);
  };

  const addDutyArea = () => {
    if (!isAdmin) return;
    const label = newDutyArea.label.trim();
    const start = newDutyArea.start;
    const end = newDutyArea.end;
    if (!label || !start || !end || end <= start) {
      notify('Enter a duty area name and valid start/end times.', 'error');
      return;
    }
    const id = `duty_${safeSlug(label)}_${Date.now()}`;
    updateDutyAreas((areas) => [
      ...areas,
      { id, label, start: hourValueFromTime(start), end: hourValueFromTime(end) },
    ]);
    setNewDutyArea({ label: '', start: '08:00', end: '09:00' });
  };

  const updateCurriculumSubjects = (transform) => {
    if (!isAdmin) return;
    setCustomConfig((current) => {
      const subjectsByLevel = { ...(current?.subjectsByLevel || {}) };
      const subjects = [
        ...(subjectsByLevel[selectedLevel] || LEVEL_SUBJECTS[selectedLevel] || [])
      ];
      subjectsByLevel[selectedLevel] = transform(subjects);
      return { ...(current || {}), subjectsByLevel };
    });
  };

  const saveCurriculumAndDutySettings = async () => {
    if (!isAdmin) return;
    const dutyAreas = customConfig?.dutyAreas || DUTY_AREAS;
    if (dutyAreas.some((area) => (
      typeof area.label !== 'string'
      || !area.label.trim()
      || !Number.isFinite(area.start)
      || !Number.isFinite(area.end)
      || area.start < 0
      || area.end > 24
      || area.start >= area.end
    ))) {
      notify('Each duty area needs a name and an end time after its start time.', 'error');
      return;
    }
    const currentSubjects = customConfig?.subjectsByLevel?.[selectedLevel] || availableSubjects;
    const normalizedSubjects = currentSubjects.map((subject) => subject.trim().toLowerCase());
    if (normalizedSubjects.some((subject) => !subject)
      || new Set(normalizedSubjects).size !== normalizedSubjects.length) {
      notify('Curriculum subjects must be non-empty and unique.', 'error');
      return;
    }

    const subjectsByLevel = { ...(customConfig?.subjectsByLevel || {}) };
    Object.entries(LEVEL_SUBJECTS).forEach(([level, subjects]) => {
      if (!subjectsByLevel[level]) subjectsByLevel[level] = subjects;
    });
    await saveSettings({
      ...(customConfig || {}),
      subjectsByLevel,
      dutyAreas,
    });
  };

  /* ---------------- Events ---------------- */

  const openEventModal = (ev = null) => {
    if (!isAdmin) return;
    if (ev) {
      setEditingEvent({ ...ev });
    } else {
      setEditingEvent({
        title: '',
        description: '',
        location: '',
        color: EVENT_COLORS[0],
        days: ['Friday'],
        periodIds: [],
        level: selectedLevel,
        classes: [],
        teacherName: '',
        teacherInitials: '',
      });
    }
    setShowEventModal(true);
  };

  const saveEventForm = async (e) => {
    e.preventDefault();
    if (!isAdmin) return;
    if (!editingEvent?.title) {
      notify('Event title is required.', 'warning');
      return;
    }
    setSaving(true);
    try {
      const id = await saveEvent(
        schoolId, selectedTerm, selectedYear, editingEvent, currentUser?.uid
      );
      setEvents((prev) => {
        const idx = prev.findIndex((ev) => ev.id === id);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = { ...editingEvent, id };
          return copy;
        }
        return [...prev, { ...editingEvent, id }];
      });
      setShowEventModal(false);
      setEditingEvent(null);
      notify('Event saved.', 'success');
    } catch (err) {
      console.error('[Timetable] save event:', err);
      notify('Failed to save event: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const removeEvent = async (ev) => {
    if (!isAdmin) return;
    if (!window.confirm(`Delete event "${ev.title}"?`)) return;
    try {
      await deleteEvent(ev.id);
      setEvents((prev) => prev.filter((x) => x.id !== ev.id));
      notify('Event deleted.', 'success');
    } catch (err) {
      console.error('[Timetable] delete event:', err);
      notify('Failed to delete: ' + err.message, 'error');
    }
  };

  /* ---------------- Period Editor ---------------- */

  const openPeriodEditor = () => {
    if (!isAdmin) return;
    setEditingPeriod({
      level: selectedLevel,
      periods: JSON.parse(JSON.stringify(periodsForLevel(selectedLevel, customConfig))),
    });
    setShowPeriodEditor(true);
  };

  const savePeriodConfig = async () => {
    if (!isAdmin) return;
    if (!editingPeriod) return;
    setSaving(true);
    try {
      const newConfig = { ...(customConfig || {}) };
      newConfig.periods = { ...(newConfig.periods || {}), [editingPeriod.level]: editingPeriod.periods };
      await saveSettings(newConfig);
      setShowPeriodEditor(false);
      setEditingPeriod(null);
    } catch (err) {
      console.error('[Timetable] save periods:', err);
    } finally {
      setSaving(false);
    }
  };

  const addPeriod = () => {
    if (!isAdmin) return;
    if (!editingPeriod) return;
    const classCount = editingPeriod.periods.filter((p) => p.type === 'class').length;
    const newId = `p${classCount + 1}_${Date.now()}`;
    const last = editingPeriod.periods[editingPeriod.periods.length - 1];
    const start = last?.end || '08:00';
    setEditingPeriod({
      ...editingPeriod,
      periods: [
        ...editingPeriod.periods,
        { id: newId, name: `Period ${classCount + 1}`, start, end: start, type: 'class' },
      ],
    });
  };

  const addBreak = () => {
    if (!isAdmin) return;
    if (!editingPeriod) return;
    const newId = `break_${Date.now()}`;
    setEditingPeriod({
      ...editingPeriod,
      periods: [
        ...editingPeriod.periods,
        { id: newId, name: 'Break', start: '10:00', end: '10:20', type: 'break', label: 'BREAK' },
      ],
    });
  };

  const updatePeriod = (idx, field, value) => {
    if (!editingPeriod) return;
    const copy = [...editingPeriod.periods];
    copy[idx] = { ...copy[idx], [field]: value };
    setEditingPeriod({ ...editingPeriod, periods: copy });
  };

  const removePeriod = (idx) => {
    if (!editingPeriod) return;
    const copy = editingPeriod.periods.filter((_, i) => i !== idx);
    setEditingPeriod({ ...editingPeriod, periods: copy });
  };

  const movePeriod = (idx, dir) => {
    if (!editingPeriod) return;
    const copy = [...editingPeriod.periods];
    const target = idx + dir;
    if (target < 0 || target >= copy.length) return;
    [copy[idx], copy[target]] = [copy[target], copy[idx]];
    setEditingPeriod({ ...editingPeriod, periods: copy });
  };

  /* ---------------- Export ---------------- */

  const exportCurrentPDF = async () => {
    try {
      const school = {
        name: schoolInfo?.name || 'School',
        address: schoolInfo?.address || '',
        phone: schoolInfo?.phone || '',
        email: schoolInfo?.email || '',
        website: schoolInfo?.website || '',
        motto: schoolInfo?.motto || '',
      };
      const logoUrl = schoolInfo?.logoUrl || schoolInfo?.schoolLogo || '';
      const livePeriods = periods;
      const liveDutyAreas = customConfig?.dutyAreas || DUTY_AREAS;
      const levelDisplay = {
        'pre-primary': 'Pre-Primary',
        'lower-primary': 'Lower Primary',
        'upper-primary': 'Upper Primary',
        'junior-school': 'Junior School',
        'senior-school': 'Senior School',
      };

      if (activeTab === 'class') {
        if (!selectedClass) {
          notify('No class selected.', 'warning');
          return;
        }
        await downloadClassTimetablePDF({
          school, logoUrl,
          className: selectedClass,
          schedule: classSchedule,
          term: normalizeTerm(selectedTerm),
          year: normalizeYear(selectedYear),
          periods: livePeriods,
          levelDisplay,
        });
      } else if (activeTab === 'duty') {
        await downloadDutyRosterPDF({
          school, logoUrl,
          roster: dutyRoster,
          term: normalizeTerm(selectedTerm),
          year: normalizeYear(selectedYear),
          dutyAreas: liveDutyAreas,
          levelDisplay,
        });
      } else if (activeTab === 'master') {
        const lvlLabel =
          SCHOOL_LEVELS.find((l) => l.value === selectedLevel)?.label || selectedLevel;
        await downloadMasterTimetablePDF({
          school, logoUrl,
          level: selectedLevel,
          levelLabel: lvlLabel,
          classes: availableClasses,
          schedules: allSchedules,
          term: normalizeTerm(selectedTerm),
          year: normalizeYear(selectedYear),
          periods: classPeriods,
          levelDisplay,
        });
      } else if (activeTab === 'teachers') {
        // Admin: export all teachers. Teacher: only their own.
        if (isTeacher) {
          if (!myTeacherLoad) {
            notify('Nothing to export yet.', 'warning');
            return;
          }
          await downloadTeacherTimetablePDF({
            school, logoUrl,
            teacher: {
              id: currentUser?.uid,
              initials: teacherInitials(userData),
              fullName: teacherFullName(userData),
            },
            assignments: myTeacherLoad.assignments,
            term: normalizeTerm(selectedTerm),
            year: normalizeYear(selectedYear),
            periods: classPeriods,
            levelDisplay,
          });
        } else {
          await Promise.all(
            teacherStats.map((t) => downloadTeacherTimetablePDF({
              school, logoUrl,
              teacher: { id: t.teacherId, initials: t.initials, fullName: t.fullName },
              assignments: t.assignments,
              term: normalizeTerm(selectedTerm),
              year: normalizeYear(selectedYear),
              periods: classPeriods,
              levelDisplay,
            }))
          );
        }
      }
      notify('PDF exported.', 'success');
    } catch (err) {
      console.error('[Timetable] export:', err);
      notify('Export failed: ' + err.message, 'error');
    }
  };

  /* ---------------- Derived ---------------- */

  const teacherStats = useMemo(
    () => summarizeTeacherLoad(allSchedules, selectedLevel, customConfig),
    [allSchedules, selectedLevel, customConfig]
  );

  const coverage = useMemo(
    () => summarizeClassCoverage(selectedLevel, availableSubjects, classSchedule, customConfig),
    [selectedLevel, availableSubjects, classSchedule, customConfig]
  );

  /* ---------------- Tab guard ---------------- */

  const handleTabChange = (tab) => {
    if (isAdmin) {
      if (classDirty && !window.confirm('Unsaved changes to the class timetable. Continue?')) return;
      if (dutyDirty && !window.confirm('Unsaved changes to the duty roster. Continue?')) return;
    }
    setActiveTab(tab);
  };

  /* ============================================================
     Renderers
     ============================================================ */

  const BrandedHeader = ({ title, subtitle }) => (
    <div className="tt-branded-header">
      <div className="tt-branded-left">
        <div className="tt-branded-logo">
          {schoolInfo?.logoUrl || schoolInfo?.schoolLogo ? (
            <img src={schoolInfo.logoUrl || schoolInfo.schoolLogo} alt="School logo" />
          ) : (
            <i className="fas fa-graduation-cap" aria-hidden="true"></i>
          )}
        </div>
        <div className="tt-branded-text">
          <h2>{schoolInfo?.name || 'School Name'}</h2>
          <p>
            {[schoolInfo?.address, schoolInfo?.phone, schoolInfo?.email]
              .filter(Boolean).join(' · ')}
          </p>
          {schoolInfo?.motto && <p className="tt-branded-motto">{schoolInfo.motto}</p>}
        </div>
      </div>
      <div className="tt-branded-right">
        <div className="tt-branded-title">{title}</div>
        <div className="tt-branded-sub">{subtitle}</div>
      </div>
    </div>
  );

  const BrandedFooter = () => (
    <div className="tt-branded-footer">
      <div>© {new Date().getFullYear()} {schoolInfo?.name || 'School'}. All rights reserved.</div>
      {schoolInfo?.motto && <div className="tt-branded-footer-motto">{schoolInfo.motto}</div>}
      <div>
        Generated {new Date().toLocaleDateString('en-KE', {
          day: '2-digit', month: 'short', year: 'numeric',
        })}
      </div>
    </div>
  );

  const renderClassTimetable = () => {
    // Teacher with no scope
    if (isTeacher && teacherClassScope.length === 0) {
      return (
        <div className="tt-empty-card">
          <i className="fas fa-user-lock" aria-hidden="true"></i>
          <h3>No classes assigned</h3>
          <p>Contact your school administrator to be assigned to classes.</p>
        </div>
      );
    }

    return (
      <div ref={printRef} className="tt-print-root">
        <BrandedHeader
          title="Class Master Timetable"
          subtitle={`${selectedClass} · ${normalizeTerm(selectedTerm)} ${normalizeYear(selectedYear)}`}
        />

        {classLoading ? (
          <div className="tt-loading"><LoadingSpinner /></div>
        ) : (
          <>
            {classClashes.length > 0 && (
              <div className="tt-clash-warn" role="alert">
                <i className="fas fa-exclamation-triangle" aria-hidden="true"></i>
                <strong>
                  {classClashes.length} clash{classClashes.length === 1 ? '' : 'es'}
                </strong>{' '}
                with other classes.
              </div>
            )}

            {coverage.missing.length > 0 && (
              <div className="tt-coverage-warn" role="alert">
                <i className="fas fa-info-circle" aria-hidden="true"></i>
                Missing subjects:{' '}
                <strong>{coverage.missing.join(', ')}</strong>
              </div>
            )}

            <div className="tt-table-wrap">
              <table className="tt-grid">
                <thead>
                  <tr>
                    <th className="tt-period-th">Time / Day</th>
                    {DAYS.map((d) => <th key={d}>{d}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {periods.map((period) => {
                    if (period.type === 'break') {
                      return (
                        <tr key={period.id} className="tt-break-row">
                          <td>{formatPeriodTime(period)}</td>
                          <td colSpan={DAYS.length}>
                            {period.label || period.name}
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={period.id}>
                        <td className="tt-period-cell">
                          <div className="tt-period-name">{period.name}</div>
                          <div className="tt-period-time">{formatPeriodTime(period)}</div>
                        </td>
                        {DAYS.map((day) => {
                          const slot = classSchedule[day]?.[period.id];
                          const isEvent = slot?.isEvent;
                          const colorCls = slot && !isEvent
                            ? (SUBJECT_CLASS[slot.subject] || 'tt-sub-default')
                            : '';
                          return (
                            <td
                              key={day}
                              onClick={() => !isEvent && isAdmin && openSlotEditor(day, period.id)}
                              className={`tt-cell ${slot ? colorCls : 'tt-cell-empty'} ${isEvent ? 'tt-cell-event' : ''} ${!isAdmin ? 'tt-cell-readonly' : ''}`}
                              style={isEvent ? { borderLeft: `3px solid ${slot.eventColor || '#d4a017'}` } : {}}
                            >
                              {slot ? (
                                <div className="tt-cell-inner">
                                  <div className="tt-cell-subject">
                                    <span className="tt-cell-subject-name">
                                      {isEvent && <i className="fas fa-star tt-event-icon" aria-hidden="true"></i>}
                                      {slot.subject}
                                    </span>
                                    {isAdmin && !isEvent && (
                                      <button
                                        type="button"
                                        className="tt-clear-btn"
                                        onClick={(e) => { e.stopPropagation(); clearSlot(day, period.id); }}
                                        title="Clear slot"
                                        aria-label="Clear slot"
                                      >
                                        <i className="fas fa-times" aria-hidden="true"></i>
                                      </button>
                                    )}
                                  </div>
                                  <div className="tt-cell-teacher">
                                    <span className="tt-teacher-chip" title={slot.teacherFullName || ''}>
                                      {slot.teacherInitials || 'TBA'}
                                    </span>
                                  </div>
                                  {slot.room && <div className="tt-cell-room">{slot.room}</div>}
                                </div>
                              ) : (
                                <div className="tt-cell-placeholder">
                                  {isAdmin ? '+ Assign' : '—'}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <BrandedFooter />
      </div>
    );
  };

  const renderTeacherTimetables = () => {
    // Teacher: show only their own.
    if (isTeacher) {
      if (!myTeacherLoad || myTeacherLoad.assignments.length === 0) {
        return (
          <div ref={printRef} className="tt-print-root">
            <BrandedHeader
              title="My Timetable"
              subtitle={`${normalizeTerm(selectedTerm)} ${normalizeYear(selectedYear)}`}
            />
            <div className="tt-empty">
              <i className="fas fa-calendar-xmark" aria-hidden="true"></i>
              <p>No periods assigned to you for this level and term.</p>
            </div>
            <BrandedFooter />
          </div>
        );
      }

      const t = myTeacherLoad;
      return (
        <div ref={printRef} className="tt-print-root">
          <BrandedHeader
            title="My Teaching Timetable"
            subtitle={`${teacherFullName(userData)} · ${normalizeTerm(selectedTerm)} ${normalizeYear(selectedYear)}`}
          />
          <div className="tt-teachers-stack">
            <div className="tt-workload-table">
              <div className="tt-section-label">Workload Summary</div>
              <table>
                <thead>
                  <tr>
                    <th>Periods / Week</th>
                    <th>Classes Taught</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="tt-center tt-bold">{t.totalPeriods}</td>
                    <td className="tt-center">{t.classes.join(', ') || '—'}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="tt-teacher-card">
              <div className="tt-teacher-card-header">
                <span>{teacherFullName(userData)}</span>
                <span className="tt-teacher-count">{t.totalPeriods} periods/week</span>
              </div>
              <table className="tt-teacher-grid">
                <thead>
                  <tr>
                    <th>Time</th>
                    {DAYS.map((d) => <th key={d}>{d}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {classPeriods.map((p) => (
                    <tr key={p.id}>
                      <td className="tt-teacher-period">
                        <div className="tt-period-name">{p.name}</div>
                        <div className="tt-period-time">{formatPeriodTime(p)}</div>
                      </td>
                      {DAYS.map((day) => {
                        const slot = t.assignments.find(
                          (a) => a.day === day && a.period.id === p.id
                        );
                        return (
                          <td key={day} className="tt-teacher-cell">
                            {slot ? (
                              <>
                                <div className="tt-teacher-subject">{slot.subject}</div>
                                <div className="tt-teacher-class">{slot.className}</div>
                              </>
                            ) : <span className="tt-muted">·</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <BrandedFooter />
        </div>
      );
    }

    // Admin: show all teachers (existing view).
    return (
      <div ref={printRef} className="tt-print-root">
        <BrandedHeader
          title="Teacher Timetables & Workload"
          subtitle={`${selectedLevel} · ${normalizeTerm(selectedTerm)} ${normalizeYear(selectedYear)}`}
        />
        {!teacherStats.length ? (
          <div className="tt-empty">
            <i className="fas fa-chalkboard-user" aria-hidden="true"></i>
            <p>No teachers assigned yet. Generate or edit a class timetable first.</p>
          </div>
        ) : (
          <div className="tt-teachers-stack">
            <div className="tt-workload-table">
              <div className="tt-section-label">Workload Summary</div>
              <table>
                <thead>
                  <tr>
                    <th>Initials</th>
                    <th>Teacher</th>
                    <th className="tt-center">Periods / Week</th>
                    <th className="tt-center">Classes Taught</th>
                  </tr>
                </thead>
                <tbody>
                  {teacherStats.map((t) => (
                    <tr key={t.teacherId}>
                      <td className="tt-initials-cell">{t.initials}</td>
                      <td>{t.fullName}</td>
                      <td className="tt-center tt-bold">{t.assignments.length}</td>
                      <td className="tt-center">{t.classes.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {teacherStats.map((t) => (
              <div key={t.teacherId} className="tt-teacher-card">
                <div className="tt-teacher-card-header">
                  <span>
                    {t.fullName} <span className="tt-muted">({t.initials})</span>
                  </span>
                  <span className="tt-teacher-count">{t.assignments.length} periods/week</span>
                </div>
                <table className="tt-teacher-grid">
                  <thead>
                    <tr>
                      <th>Time</th>
                      {DAYS.map((d) => <th key={d}>{d}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {classPeriods.map((p) => (
                      <tr key={p.id}>
                        <td className="tt-teacher-period">
                          <div className="tt-period-name">{p.name}</div>
                          <div className="tt-period-time">{formatPeriodTime(p)}</div>
                        </td>
                        {DAYS.map((day) => {
                          const slot = t.assignments.find(
                            (a) => a.day === day && a.period.id === p.id
                          );
                          return (
                            <td key={day} className="tt-teacher-cell">
                              {slot ? (
                                <>
                                  <div className="tt-teacher-subject">{slot.subject}</div>
                                  <div className="tt-teacher-class">{slot.className}</div>
                                </>
                              ) : <span className="tt-muted">·</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
        <BrandedFooter />
      </div>
    );
  };

  const renderMasterOverview = () => {
    const visibleClasses = availableClasses;
    return (
      <div ref={printRef} className="tt-print-root">
        <BrandedHeader
          title="Master Timetable Overview"
          subtitle={`${isTeacher ? 'My Classes' : 'All Classes'} · ${selectedLevel} · ${normalizeTerm(selectedTerm)} ${normalizeYear(selectedYear)}`}
        />
        {!visibleClasses.length ? (
          <div className="tt-empty">
            <i className="fas fa-school" aria-hidden="true"></i>
            <p>{isTeacher ? 'No classes assigned to you.' : 'No classes found for this level.'}</p>
          </div>
        ) : (
          <div className="tt-master-stack">
            {visibleClasses.map((cls) => {
              const sched = allSchedules[cls] || {};
              return (
                <div key={cls} className="tt-master-card">
                  <div className="tt-master-title">{cls}</div>
                  <table className="tt-master-grid">
                    <thead>
                      <tr>
                        <th>Time</th>
                        {DAYS.map((d) => <th key={d}>{d.slice(0, 3)}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {classPeriods.map((p) => (
                        <tr key={p.id}>
                          <td className="tt-master-period">{p.name.replace('Period ', 'P')}</td>
                          {DAYS.map((day) => {
                            const slot = sched?.[day]?.[p.id];
                            return (
                              <td key={day} className={`tt-master-cell ${slot?.isEvent ? 'tt-master-event' : ''}`}>
                                {slot ? (
                                  <>
                                    <div className="tt-master-subject">{slot.subject}</div>
                                    <div className="tt-master-teacher">{slot.teacherInitials}</div>
                                  </>
                                ) : <span className="tt-muted">·</span>}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        )}
        <BrandedFooter />
      </div>
    );
  };

  const renderDutyRoster = () => {
    const areas = customConfig?.dutyAreas || DUTY_AREAS;
    return (
      <div ref={printRef} className="tt-print-root">
        <BrandedHeader
          title="Weekly Duty Roster"
          subtitle={`${normalizeTerm(selectedTerm)} ${normalizeYear(selectedYear)}`}
        />

        {dutyClashes.length > 0 && (
          <div className="tt-clash-warn" role="alert">
            <i className="fas fa-exclamation-triangle" aria-hidden="true"></i>
            <strong>
              {dutyClashes.length} duty clash{dutyClashes.length === 1 ? '' : 'es'}
            </strong>{' '}
            — a teacher is assigned to overlapping duties.
          </div>
        )}

        <div className="tt-table-wrap">
          <table className="tt-grid tt-duty-grid">
            <thead>
              <tr>
                <th className="tt-duty-area-th">Duty Area / Time</th>
                {DAYS.map((d) => <th key={d}>{d}</th>)}
              </tr>
            </thead>
            <tbody>
              {areas.map((area) => (
                <tr key={area.id}>
                  <td className="tt-period-cell">
                    <div className="tt-period-name">{area.label}</div>
                    <div className="tt-period-time">
                      {fmtHour(area.start)} – {fmtHour(area.end)}
                    </div>
                  </td>
                  {DAYS.map((day) => {
                    const entry = dutyRoster?.[day]?.[area.id];
                    return (
                      <td key={day} className="tt-duty-cell">
                        {isAdmin ? (
                          <select
                            className="tt-duty-select"
                            value={entry?.teacherId || ''}
                            onChange={(e) => assignDuty(day, area.id, e.target.value)}
                            aria-label={`Duty ${area.label} on ${day}`}
                          >
                            <option value="">—</option>
                            {teachers.map((t) => (
                              <option key={t.id} value={t.id}>
                                {teacherInitials(t)} · {teacherFullName(t)}
                              </option>
                            ))}
                          </select>
                        ) : entry ? (
                          <>
                            <div className="tt-initials-cell">{entry.teacherInitials}</div>
                            <div className="tt-muted-small">{entry.teacherFullName}</div>
                          </>
                        ) : <span className="tt-muted">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <BrandedFooter />
      </div>
    );
  };

  const renderEvents = () => (
    <div className="tt-events-page">
      <div className="tt-events-header">
        <div>
          <h2 className="tt-events-title">Events & Activities</h2>
          <p className="tt-events-sub">
            Games, clubs, assemblies and special activities that override regular lessons.
          </p>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => openEventModal()}>
            <i className="fas fa-plus" aria-hidden="true"></i> Add Event
          </button>
        )}
      </div>

      {events.length === 0 ? (
        <div className="tt-empty">
          <i className="fas fa-calendar-check" aria-hidden="true"></i>
          <p>No events configured for this term.</p>
        </div>
      ) : (
        <div className="tt-events-grid">
          {events.map((ev) => (
            <div
              key={ev.id}
              className="tt-event-card"
              style={{ borderLeftColor: ev.color || '#d4a017' }}
            >
              <div className="tt-event-card-header">
                <div className="tt-event-color" style={{ background: ev.color || '#d4a017' }} />
                <div className="tt-event-card-title">{ev.title}</div>
                <div className="tt-event-card-actions">
                  {isAdmin && (
                    <>
                      <button
                        className="tt-icon-btn"
                        onClick={() => openEventModal(ev)}
                        title="Edit"
                      >
                        <i className="fas fa-pen" aria-hidden="true"></i>
                      </button>
                      <button
                        className="tt-icon-btn tt-icon-danger"
                        onClick={() => removeEvent(ev)}
                        title="Delete"
                      >
                        <i className="fas fa-trash" aria-hidden="true"></i>
                      </button>
                    </>
                  )}
                </div>
              </div>
              {ev.description && <p className="tt-event-desc">{ev.description}</p>}
              <div className="tt-event-meta">
                {ev.days?.length > 0 && (
                  <div className="tt-event-meta-item">
                    <i className="fas fa-calendar-day" aria-hidden="true"></i>
                    {ev.days.join(', ')}
                  </div>
                )}
                {ev.periodIds?.length > 0 && (
                  <div className="tt-event-meta-item">
                    <i className="fas fa-clock" aria-hidden="true"></i>
                    {ev.periodIds.map((pid) => periods.find((p) => p.id === pid)?.name || pid).join(', ')}
                  </div>
                )}
                {ev.location && (
                  <div className="tt-event-meta-item">
                    <i className="fas fa-location-dot" aria-hidden="true"></i>
                    {ev.location}
                  </div>
                )}
                {ev.teacherName && (
                  <div className="tt-event-meta-item">
                    <i className="fas fa-user" aria-hidden="true"></i>
                    {ev.teacherName}
                  </div>
                )}
                {ev.level && (
                  <div className="tt-event-meta-item">
                    <i className="fas fa-layer-group" aria-hidden="true"></i>
                    {ev.level}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderSettings = () => {
    if (!isAdmin) {
      return (
        <div className="tt-empty-card">
          <i className="fas fa-lock" aria-hidden="true"></i>
          <h3>Settings are admin-only</h3>
          <p>Contact your school administrator to change the timetable configuration.</p>
        </div>
      );
    }

    return (
      <div className="tt-settings">
        <section className="card">
          <div className="tt-settings-head">
            <div>
              <h3 className="tt-settings-title">
                <i className="fas fa-clock" aria-hidden="true"></i> Period & Break Schedule
              </h3>
              <p className="tt-settings-desc">
                Configure lesson times, durations, and breaks for <strong>{selectedLevel}</strong>.
              </p>
            </div>
            {isAdmin && (
              <button className="btn btn-primary" onClick={openPeriodEditor}>
                <i className="fas fa-pen-to-square" aria-hidden="true"></i> Edit Schedule
              </button>
            )}
          </div>
          <div className="tt-period-list">
            {periods.map((p) => (
              <div key={p.id} className={`tt-period-chip ${p.type === 'break' ? 'break' : ''}`}>
                <div className="tt-period-chip-name">{p.name}</div>
                <div className="tt-period-chip-time">{formatPeriodTime(p)}</div>
                <div className="tt-period-chip-duration">
                  {calcDuration(p.start, p.end) || ''} min
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <h3 className="tt-settings-title">
            <i className="fas fa-chalkboard-user" aria-hidden="true"></i> Teacher Subject Mapping
          </h3>
          <p className="tt-settings-desc">
            Teachers without a <code>subjects</code> array are treated as generalists and can
            be assigned any subject.
          </p>
          {teachers.length ? (
            <div className="tt-table-wrap">
              <table className="tt-settings-table">
                <thead>
                  <tr>
                    <th>Initials</th>
                    <th>Teacher</th>
                    <th>Subjects Assigned</th>
                    <th className="tt-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {teachers.map((t) => {
                    const hasSubs = Array.isArray(t.subjects) && t.subjects.length > 0;
                    return (
                      <tr key={t.id}>
                        <td className="tt-initials-cell">{teacherInitials(t)}</td>
                        <td>{teacherFullName(t)}</td>
                        <td>
                          {hasSubs
                            ? t.subjects.join(', ')
                            : <span className="tt-muted">Not restricted</span>}
                        </td>
                        <td className="tt-center">
                          <span className={`tt-chip ${hasSubs ? 'tt-chip-ok' : 'tt-chip-neutral'}`}>
                            {hasSubs ? 'Configured' : 'General'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="tt-empty">
              <i className="fas fa-user-slash" aria-hidden="true"></i>
              <p>No teachers loaded.</p>
            </div>
          )}
        </section>

        <section className="card">
          <div className="tt-settings-head">
            <div>
              <h3 className="tt-settings-title">
                <i className="fas fa-list-check" aria-hidden="true"></i> Curriculum Subjects ({availableSubjects.length})
              </h3>
              <p className="tt-settings-desc">Manage curriculum subjects for each school level.</p>
            </div>
            {isAdmin && (
              <button
                className="btn btn-success"
                onClick={saveCurriculumAndDutySettings}
                disabled={saving}
              >
                <i className={`fas ${saving ? 'fa-spinner fa-spin' : 'fa-save'}`} aria-hidden="true"></i>
                {saving ? 'Saving…' : 'Save Settings'}
              </button>
            )}
          </div>
          <div className="tt-filter-group" style={{ maxWidth: 300, marginBottom: 16 }}>
            <label htmlFor="tt-subject-level">School Level</label>
            <select
              id="tt-subject-level"
              value={selectedLevel}
              onChange={(event) => setSelectedLevel(event.target.value)}
            >
              {SCHOOL_LEVELS.map((level) => (
                <option key={level.value} value={level.value}>{level.label}</option>
              ))}
            </select>
          </div>
          <div className="tt-subject-chips">
            {availableSubjects.map((subject, index) => (
              <span key={`${subject}-${index}`} className="tt-chip tt-chip-primary">
                {isAdmin ? (
                  <>
                    <input
                      aria-label={`Edit subject ${subject}`}
                      value={subject}
                      onChange={(event) => updateCurriculumSubjects((subjects) => subjects.map(
                        (value, subjectIndex) => subjectIndex === index ? event.target.value : value
                      ))}
                      style={{ width: `${Math.max(subject.length, 8)}ch`, border: 0, background: 'transparent', color: 'inherit' }}
                    />
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      aria-label={`Delete ${subject}`}
                      onClick={() => updateCurriculumSubjects((subjects) => subjects.filter((_, i) => i !== index))}
                    >
                      <i className="fas fa-trash" aria-hidden="true"></i>
                    </button>
                  </>
                ) : subject}
              </span>
            ))}
          </div>
          {isAdmin && (
            <form
              className="tt-inline-form"
              style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}
              onSubmit={(event) => {
                event.preventDefault();
                const subject = newSubject.trim();
                if (!subject) return;
                if (availableSubjects.some((value) => value.toLowerCase() === subject.toLowerCase())) {
                  notify('That subject is already listed for this level.', 'warning');
                  return;
                }
                updateCurriculumSubjects((subjects) => [...subjects, subject]);
                setNewSubject('');
              }}
            >
              <input
                value={newSubject}
                onChange={(event) => setNewSubject(event.target.value)}
                placeholder="Add a subject"
                aria-label="New curriculum subject"
                maxLength={80}
              />
              <button className="btn btn-primary" type="submit">
                <i className="fas fa-plus" aria-hidden="true"></i> Add Subject
              </button>
            </form>
          )}
        </section>

        <section className="card">
          <div className="tt-settings-head">
            <div>
              <h3 className="tt-settings-title">
                <i className="fas fa-shield-halved" aria-hidden="true"></i> Duty Areas
              </h3>
              <p className="tt-settings-desc">
                Add, edit, or remove duty areas used for the weekly duty roster.
              </p>
            </div>
            {isAdmin && (
              <button
                className="btn btn-success"
                onClick={saveCurriculumAndDutySettings}
                disabled={saving}
              >
                <i className={`fas ${saving ? 'fa-spinner fa-spin' : 'fa-save'}`} aria-hidden="true"></i>
                {saving ? 'Saving…' : 'Save Settings'}
              </button>
            )}
          </div>
          <div className="tt-duty-areas-list">
            {(customConfig?.dutyAreas || DUTY_AREAS).map((a) => (
              <div key={a.id} className="tt-duty-area-chip">
                {isAdmin ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) auto auto auto', gap: 8, alignItems: 'center' }}>
                    <input
                      value={a.label}
                      aria-label="Duty area name"
                      maxLength={80}
                      onChange={(event) => updateDutyArea(a.id, { label: event.target.value })}
                    />
                    <input
                      type="time"
                      value={fmtHour(a.start)}
                      aria-label={`Start time for ${a.label}`}
                      onChange={(event) => event.target.value && updateDutyArea(a.id, { start: hourValueFromTime(event.target.value) })}
                    />
                    <input
                      type="time"
                      value={fmtHour(a.end)}
                      aria-label={`End time for ${a.label}`}
                      onChange={(event) => event.target.value && updateDutyArea(a.id, { end: hourValueFromTime(event.target.value) })}
                    />
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      aria-label={`Delete duty area ${a.label}`}
                      onClick={() => removeDutyArea(a.id)}
                    >
                      <i className="fas fa-trash" aria-hidden="true"></i>
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="tt-duty-area-label">{a.label}</div>
                    <div className="tt-duty-area-time">{fmtHour(a.start)} – {fmtHour(a.end)}</div>
                  </>
                )}
              </div>
            ))}
          </div>
          {isAdmin && (
            <form
              style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap', alignItems: 'end' }}
              onSubmit={(event) => {
                event.preventDefault();
                addDutyArea();
              }}
            >
              <label>
                Duty area
                <input
                  value={newDutyArea.label}
                  onChange={(event) => setNewDutyArea((current) => ({ ...current, label: event.target.value }))}
                  placeholder="e.g. Library supervision"
                  maxLength={80}
                  required
                />
              </label>
              <label>
                Start
                <input
                  type="time"
                  value={newDutyArea.start}
                  onChange={(event) => setNewDutyArea((current) => ({ ...current, start: event.target.value }))}
                  required
                />
              </label>
              <label>
                End
                <input
                  type="time"
                  value={newDutyArea.end}
                  onChange={(event) => setNewDutyArea((current) => ({ ...current, end: event.target.value }))}
                  required
                />
              </label>
              <button className="btn btn-primary" type="submit">
                <i className="fas fa-plus" aria-hidden="true"></i> Add Duty Area
              </button>
            </form>
          )}
        </section>
      </div>
    );
  };

  /* ============================================================
     Layout
     ============================================================ */

  return (
    <Layout title="Timetable Master">
      <div className="tt-page">
        <header className="tt-page-header">
          <div>
            <div className="tt-header-badges">
              <span className="tt-badge-primary">KICD Compliant</span>
              <span className="tt-header-sub">
                {isTeacher ? 'My Timetable' : 'CBC Master Scheduler'}
              </span>
            </div>
            <h1 className="tt-page-title">
              {isTeacher ? 'My Timetable' : 'Timetable Master'}
            </h1>
            <p className="tt-page-sub">
              {isTeacher
                ? 'View your teaching schedule and the class timetables for your assigned classes.'
                : 'Generate class timetables, teacher schedules, duty rosters, and events — clash-aware.'}
            </p>
          </div>

          <div className="tt-header-actions">
            {isAdmin && activeTab === 'class' && (
              <>
                <button className="btn btn-primary" onClick={generateForCurrentClass} disabled={generating}>
                  <i className={`fas ${generating ? 'fa-spinner fa-spin' : 'fa-bolt'}`} aria-hidden="true"></i>
                  {generating ? 'Generating…' : 'Smart Generate'}
                </button>
                <button className="btn btn-outline" onClick={() => setShowBulkModal(true)}>
                  <i className="fas fa-layer-group" aria-hidden="true"></i> All Classes
                </button>
                <button className="btn btn-success" onClick={saveCurrentClass} disabled={saving || !classDirty}>
                  <i className={`fas ${saving ? 'fa-spinner fa-spin' : 'fa-save'}`} aria-hidden="true"></i>
                  {saving ? 'Saving…' : classDirty ? 'Save *' : 'Saved'}
                </button>
              </>
            )}
            {isAdmin && activeTab === 'duty' && (
              <>
                <button className="btn btn-outline" onClick={generateDuty}>
                  <i className="fas fa-bolt" aria-hidden="true"></i> Auto-Assign
                </button>
                <button className="btn btn-success" onClick={saveDuty} disabled={saving || !dutyDirty}>
                  <i className={`fas ${saving ? 'fa-spinner fa-spin' : 'fa-save'}`} aria-hidden="true"></i>
                  {saving ? 'Saving…' : dutyDirty ? 'Save *' : 'Saved'}
                </button>
              </>
            )}
            {activeTab !== 'settings' && activeTab !== 'events' && (
              <button className="btn btn-primary" onClick={exportCurrentPDF}>
                <i className="fas fa-file-pdf" aria-hidden="true"></i> Export PDF
              </button>
            )}
          </div>
        </header>

        {feedback.message && (
          <div className={`tt-feedback tt-feedback-${feedback.type}`} role="status">
            <i
              className={`fas ${
                feedback.type === 'error' ? 'fa-circle-exclamation'
                : feedback.type === 'warning' ? 'fa-triangle-exclamation'
                : 'fa-circle-check'
              }`}
              aria-hidden="true"
            ></i>
            <span>{feedback.message}</span>
          </div>
        )}

        <nav className="tt-tabs" aria-label="Timetable sections">
          {TABS.filter((t) => {
            // Teachers don't need the Settings tab.
            if (t.id === 'settings' && isTeacher) return false;
            return true;
          }).map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tt-tab ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => handleTabChange(t.id)}
              aria-current={activeTab === t.id ? 'page' : undefined}
            >
              <i className={`fas ${t.icon}`} aria-hidden="true"></i>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>

        {activeTab !== 'settings' && (
          <div className="tt-filters">
            {activeTab !== 'duty' && activeTab !== 'events' && (
              <>
                <div className="tt-filter-group">
                  <label>School Level</label>
                  <select value={selectedLevel} onChange={(e) => setSelectedLevel(e.target.value)}>
                    {SCHOOL_LEVELS.map((l) => (
                      <option key={l.value} value={l.value}>{l.label}</option>
                    ))}
                  </select>
                </div>
                <div className="tt-filter-group">
                  <label>Class / Stream</label>
                  <select
                    value={selectedClass}
                    onChange={(e) => setSelectedClass(e.target.value)}
                    disabled={activeTab === 'teachers' || activeTab === 'master' || availableClasses.length === 0}
                  >
                    {availableClasses.length === 0 && isTeacher ? (
                      <option value="">— No classes assigned —</option>
                    ) : (
                      availableClasses.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))
                    )}
                  </select>
                </div>
              </>
            )}
            <div className="tt-filter-group">
              <label>Term</label>
              <select value={selectedTerm} onChange={(e) => setSelectedTerm(e.target.value)}>
                <option>Term 1</option>
                <option>Term 2</option>
                <option>Term 3</option>
              </select>
            </div>
            <div className="tt-filter-group">
              <label>Academic Year</label>
              <select value={selectedYear} onChange={(e) => setSelectedYear(Number(e.target.value))}>
                {[new Date().getFullYear() - 1, new Date().getFullYear(), new Date().getFullYear() + 1]
                  .map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
        )}

        {activeTab === 'class' && renderClassTimetable()}
        {activeTab === 'teachers' && renderTeacherTimetables()}
        {activeTab === 'master' && renderMasterOverview()}
        {activeTab === 'duty' && renderDutyRoster()}
        {activeTab === 'events' && renderEvents()}
        {activeTab === 'settings' && renderSettings()}

        {/* ---------- Slot editor ---------- */}
        {showSlotModal && editingSlot && isAdmin && (
          <div
            className="modal-overlay active"
            onClick={(e) => e.target === e.currentTarget && setShowSlotModal(false)}
          >
            <div className="modal" style={{ maxWidth: 460 }}>
              <div className="modal-header">
                <h2>
                  {editingSlot.day} · {periods.find((p) => p.id === editingSlot.periodId)?.name}
                </h2>
                <button className="modal-close" onClick={() => setShowSlotModal(false)}>
                  <i className="fas fa-times" aria-hidden="true"></i>
                </button>
              </div>
              <form onSubmit={saveSlot}>
                <div className="form-group">
                  <label>Subject <span className="required">*</span></label>
                  <select
                    value={editingSlot.subject || ''}
                    onChange={(e) => setEditingSlot({ ...editingSlot, subject: e.target.value })}
                    required
                  >
                    <option value="">— Select subject —</option>
                    {availableSubjects.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Teacher</label>
                  <select
                    value={editingSlot.teacherId || ''}
                    onChange={(e) => setEditingSlot({ ...editingSlot, teacherId: e.target.value })}
                  >
                    <option value="">— Unassigned —</option>
                    {teachers.map((t) => (
                      <option key={t.id} value={t.id}>
                        {teacherInitials(t)} · {teacherFullName(t)}
                        {Array.isArray(t.subjects) && t.subjects.length
                          ? ` · ${t.subjects.join(', ')}`
                          : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Room / Location</label>
                  <input
                    type="text"
                    value={editingSlot.room || ''}
                    onChange={(e) => setEditingSlot({ ...editingSlot, room: e.target.value })}
                    placeholder="e.g. Room 101, Science Lab"
                  />
                </div>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => setShowSlotModal(false)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary">Save Slot</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ---------- Bulk generate ---------- */}
        {isAdmin && showBulkModal && (
          <div
            className="modal-overlay active"
            onClick={(e) =>
              e.target === e.currentTarget && !bulkGenerating && setShowBulkModal(false)
            }
          >
            <div className="modal" style={{ maxWidth: 520 }}>
              <div className="modal-header">
                <h2>
                  <i className="fas fa-layer-group" aria-hidden="true"></i> Generate All Classes
                </h2>
                <button
                  className="modal-close"
                  onClick={() => setShowBulkModal(false)}
                  disabled={bulkGenerating}
                >
                  <i className="fas fa-times" aria-hidden="true"></i>
                </button>
              </div>
              <p style={{ fontSize: 14, color: 'var(--text-soft)', marginBottom: 16, lineHeight: 1.55 }}>
                This will generate timetables for <strong>{availableClasses.length}</strong> classes
                in <strong>{selectedLevel}</strong> and save them. Existing timetables for these
                classes will be <strong>overwritten</strong>.
              </p>
              <div className="tt-warn-box">
                <i className="fas fa-triangle-exclamation" aria-hidden="true"></i>
                Teachers should have a <code>subjects</code> array on their profile for best results.
              </div>
              <div className="modal-footer">
                <button
                  className="btn btn-outline"
                  onClick={() => setShowBulkModal(false)}
                  disabled={bulkGenerating}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={generateForAllClasses}
                  disabled={bulkGenerating}
                >
                  {bulkGenerating ? (
                    <><i className="fas fa-spinner fa-spin" aria-hidden="true"></i> Generating…</>
                  ) : (
                    <><i className="fas fa-bolt" aria-hidden="true"></i> Generate All</>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ---------- Event editor ---------- */}
        {isAdmin && showEventModal && editingEvent && (
          <div
            className="modal-overlay active"
            onClick={(e) => e.target === e.currentTarget && setShowEventModal(false)}
          >
            <div className="modal" style={{ maxWidth: 560 }}>
              <div className="modal-header">
                <h2>
                  <i className="fas fa-calendar-plus" aria-hidden="true"></i>
                  {editingEvent.id ? 'Edit Event' : 'New Event'}
                </h2>
                <button className="modal-close" onClick={() => setShowEventModal(false)}>
                  <i className="fas fa-times" aria-hidden="true"></i>
                </button>
              </div>
              <form onSubmit={saveEventForm}>
                <div className="form-group">
                  <label>Title <span className="required">*</span></label>
                  <input
                    type="text"
                    value={editingEvent.title}
                    onChange={(e) => setEditingEvent({ ...editingEvent, title: e.target.value })}
                    placeholder="e.g. Inter-house Games"
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Description</label>
                  <textarea
                    rows={2}
                    value={editingEvent.description || ''}
                    onChange={(e) => setEditingEvent({ ...editingEvent, description: e.target.value })}
                    placeholder="Optional details"
                  />
                </div>
                <div className="tt-form-row">
                  <div className="form-group">
                    <label>Location</label>
                    <input
                      type="text"
                      value={editingEvent.location || ''}
                      onChange={(e) => setEditingEvent({ ...editingEvent, location: e.target.value })}
                      placeholder="e.g. Main Field"
                    />
                  </div>
                  <div className="form-group">
                    <label>Colour</label>
                    <div className="tt-color-picker">
                      {EVENT_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`tt-color-swatch ${editingEvent.color === c ? 'active' : ''}`}
                          style={{ background: c }}
                          onClick={() => setEditingEvent({ ...editingEvent, color: c })}
                          aria-label={`Choose colour ${c}`}
                        />
                      ))}
                    </div>
                  </div>
                </div>
                <div className="form-group">
                  <label>Days</label>
                  <div className="tt-day-picker">
                    {DAYS.map((d) => (
                      <label key={d} className="tt-day-chip">
                        <input
                          type="checkbox"
                          checked={(editingEvent.days || []).includes(d)}
                          onChange={(e) => {
                            const days = editingEvent.days || [];
                            setEditingEvent({
                              ...editingEvent,
                              days: e.target.checked
                                ? [...days, d]
                                : days.filter((x) => x !== d),
                            });
                          }}
                        />
                        <span>{d.slice(0, 3)}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="form-group">
                  <label>Periods</label>
                  <div className="tt-period-picker">
                    {classPeriods.map((p) => (
                      <label key={p.id} className="tt-period-chip-sm">
                        <input
                          type="checkbox"
                          checked={(editingEvent.periodIds || []).includes(p.id)}
                          onChange={(e) => {
                            const pids = editingEvent.periodIds || [];
                            setEditingEvent({
                              ...editingEvent,
                              periodIds: e.target.checked
                                ? [...pids, p.id]
                                : pids.filter((x) => x !== p.id),
                            });
                          }}
                        />
                        <span>{p.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="tt-form-row">
                  <div className="form-group">
                    <label>Teacher (optional)</label>
                    <select
                      value={editingEvent.teacherName || ''}
                      onChange={(e) => {
                        const t = teachers.find((x) => teacherFullName(x) === e.target.value);
                        setEditingEvent({
                          ...editingEvent,
                          teacherName: t ? teacherFullName(t) : '',
                          teacherInitials: t ? teacherInitials(t) : '',
                        });
                      }}
                    >
                      <option value="">— None —</option>
                      {teachers.map((t) => (
                        <option key={t.id} value={teacherFullName(t)}>{teacherFullName(t)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Applies to</label>
                    <select
                      value={editingEvent.level || ''}
                      onChange={(e) => setEditingEvent({ ...editingEvent, level: e.target.value })}
                    >
                      <option value="">All Levels</option>
                      {SCHOOL_LEVELS.map((l) => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => setShowEventModal(false)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={saving}>
                    {saving ? 'Saving…' : 'Save Event'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ---------- Period editor ---------- */}
        {isAdmin && showPeriodEditor && editingPeriod && (
          <div
            className="modal-overlay active"
            onClick={(e) => e.target === e.currentTarget && setShowPeriodEditor(false)}
          >
            <div className="modal" style={{ maxWidth: 720 }}>
              <div className="modal-header">
                <h2>
                  <i className="fas fa-clock" aria-hidden="true"></i>
                  Edit Period Schedule — {editingPeriod.level}
                </h2>
                <button className="modal-close" onClick={() => setShowPeriodEditor(false)}>
                  <i className="fas fa-times" aria-hidden="true"></i>
                </button>
              </div>

              <div className="tt-period-editor">
                <div className="tt-period-editor-head">
                  <span>Name</span>
                  <span>Start</span>
                  <span>End</span>
                  <span>Type</span>
                  <span></span>
                </div>
                {editingPeriod.periods.map((p, idx) => (
                  <div key={p.id || idx} className="tt-period-editor-row">
                    <input
                      type="text"
                      value={p.name}
                      onChange={(e) => updatePeriod(idx, 'name', e.target.value)}
                    />
                    <input
                      type="time"
                      value={p.start || ''}
                      onChange={(e) => updatePeriod(idx, 'start', e.target.value)}
                    />
                    <input
                      type="time"
                      value={p.end || ''}
                      onChange={(e) => updatePeriod(idx, 'end', e.target.value)}
                    />
                    <select
                      value={p.type}
                      onChange={(e) => updatePeriod(idx, 'type', e.target.value)}
                    >
                      <option value="class">Class</option>
                      <option value="break">Break</option>
                    </select>
                    <div className="tt-period-editor-actions">
                      <button className="tt-icon-btn" onClick={() => movePeriod(idx, -1)} title="Move up">
                        <i className="fas fa-arrow-up" aria-hidden="true"></i>
                      </button>
                      <button className="tt-icon-btn" onClick={() => movePeriod(idx, 1)} title="Move down">
                        <i className="fas fa-arrow-down" aria-hidden="true"></i>
                      </button>
                      <button className="tt-icon-btn tt-icon-danger" onClick={() => removePeriod(idx)} title="Remove">
                        <i className="fas fa-trash" aria-hidden="true"></i>
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="tt-period-editor-add">
                <button className="btn btn-outline" onClick={addPeriod}>
                  <i className="fas fa-plus" aria-hidden="true"></i> Add Period
                </button>
                <button className="btn btn-outline" onClick={addBreak}>
                  <i className="fas fa-mug-hot" aria-hidden="true"></i> Add Break
                </button>
              </div>

              <div className="modal-footer">
                <button
                  className="btn btn-outline"
                  onClick={() => setShowPeriodEditor(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={savePeriodConfig}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save Schedule'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

/* ============================================================
   Misc helpers local to this page
   ============================================================ */

function buildExistingTeacherLoad(allSchedules, level, customConfig = null) {
  const periods = classPeriodsForLevel(level, customConfig);
  const load = {};
  for (const sched of Object.values(allSchedules || {})) {
    for (const day of DAYS) {
      for (const p of periods) {
        const slot = sched?.[day]?.[p.id];
        if (slot?.teacherId) {
          load[slot.teacherId] = (load[slot.teacherId] || 0) + 1;
        }
      }
    }
  }
  return load;
}

function fmtHour(h) {
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  return `${String(whole).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function hourValueFromTime(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours + minutes / 60;
}
