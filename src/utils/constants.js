// CBC Level Structure
export const LEVEL_ORDER = ['pre-primary', 'lower-primary', 'upper-primary', 'junior-school', 'senior-school'];

export const LEVEL_CLASSES = {
  'pre-primary': ['PP1', 'PP2'],
  'lower-primary': ['Grade 1', 'Grade 2', 'Grade 3'],
  'upper-primary': ['Grade 4', 'Grade 5', 'Grade 6'],
  'junior-school': ['Grade 7', 'Grade 8', 'Grade 9'],
  'senior-school': ['Grade 10', 'Grade 11', 'Grade 12']
};

export const LEVEL_DISPLAY_NAMES = {
  'pre-primary': 'Pre-Primary',
  'lower-primary': 'Lower Primary',
  'upper-primary': 'Upper Primary',
  'junior-school': 'Junior School',
  'senior-school': 'Senior School'
};

export const LEVEL_BADGE_CLASSES = {
  'pre-primary': 'pre-primary',
  'lower-primary': 'lower-primary',
  'upper-primary': 'upper-primary',
  'junior-school': 'junior-school',
  'senior-school': 'senior-school'
};

// CBC Subjects by Level
export const LEVEL_SUBJECTS = {
  'pre-primary': [
    'Language Activities',
    'Mathematical Activities',
    'Environmental Activities',
    'Psychomotor Activities',
    'Religious Education'
  ],
  'lower-primary': [
    'English',
    'Kiswahili',
    'Mathematics',
    'Science and Technology',
    'Social Studies',
    'CRE/IRE/HRE',
    'Music',
    'Environmental',
    'Creative Activities',
    'Physical Education'
  ],
  'upper-primary': [
    'English',
    'Kiswahili',
    'Mathematics',
    'Science and Technology',
    'Social Studies',
    'CRE/IRE/HRE',
    'Creative Arts',
    'Agriculture',
    'Music',
    'Physical Education'
    
  ],
  'junior-school': [
    'English',
    'Kiswahili',
    'Mathematics',
    'Integrated Science',
    'Social Studies',
    'Religious Education',
    'Pre-Technical Studies',
    'Agriculture and Nutrition',
    'Creative Arts and Sports'
  ],
  'senior-school': [
    'English',
    'Kiswahili',
    'Mathematics',
    'Biology',
    'Chemistry',
    'Physics',
    'History',
    'Geography',
    'CRE/IRE/HRE',
    'Business Studies',
    'Computer Science'
  ]
};

// CBC Grading System
export const CBC_GRADING_SYSTEM = {
  'EE1': { level: 'EE', label: 'Exceeding Expectation', min: 90, max: 100, points: 8.0 },
  'EE2': { level: 'EE', label: 'Exceeding Expectation', min: 75, max: 89, points: 7.0 },
  'ME1': { level: 'ME', label: 'Meeting Expectation', min: 58, max: 74, points: 6.0 },
  'ME2': { level: 'ME', label: 'Meeting Expectation', min: 41, max: 57, points: 5.0 },
  'AE1': { level: 'AE', label: 'Approaching Expectation', min: 31, max: 40, points: 4.0 },
  'AE2': { level: 'AE', label: 'Approaching Expectation', min: 21, max: 30, points: 3.0 },
  'BE1': { level: 'BE', label: 'Below Expectation', min: 11, max: 20, points: 2.0 },
  'BE2': { level: 'BE', label: 'Below Expectation', min: 1, max: 10, points: 1.0 }
};

// Get CBC Grade
export const getCBCGrade = (score) => {
  if (score === null || score === undefined || score === 0) {
    return { code: 'NA', level: 'NA', label: 'Not Assessed', points: 0, levelClass: 'na' };
  }

  const roundedScore = Math.round(score);
  const sortedGrades = Object.entries(CBC_GRADING_SYSTEM).sort((a, b) => b[1].min - a[1].min);
  
  for (const [code, grade] of sortedGrades) {
    if (roundedScore >= grade.min && roundedScore <= grade.max) {
      return {
        code: code,
        level: grade.level,
        label: grade.label,
        points: grade.points,
        levelClass: grade.level.toLowerCase()
      };
    }
  }

  return { code: 'NA', level: 'NA', label: 'Not Assessed', points: 0, levelClass: 'na' };
};

// Status options
export const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'pending', label: 'Pending' },
  { value: 'promoted', label: 'Promoted' }
];

// Assessment types
export const ASSESSMENT_TYPES = [
  { value: 'Assessment 1', label: 'ASSESSMENT 1' },
  { value: 'Assessment 2', label: 'ASSESSMENT 2' },
  { value: 'Assessment 3', label: 'ASSESSMENT 3' }
];

// School levels
export const SCHOOL_LEVELS = [
  { value: 'pre-primary', label: 'Pre-Primary' },
  { value: 'lower-primary', label: 'Lower Primary' },
  { value: 'upper-primary', label: 'Upper Primary' },
  { value: 'junior-school', label: 'Junior School' },
  { value: 'senior-school', label: 'Senior School' }
];

// Curriculum options
export const CURRICULUM_OPTIONS = [
  { value: 'cbc', label: 'CBC (Competency-Based Curriculum)' },
  { value: 'cbe', label: 'CBE (Competency-Based Education)' },
  { value: '8-4-4', label: '8-4-4 System' },
  { value: 'igcse', label: 'IGCSE' },
  { value: 'ib', label: 'International Baccalaureate' }
];

// School types
export const SCHOOL_TYPES = [
  { value: 'primary', label: 'Primary School' },
  { value: 'secondary', label: 'Secondary School' },
  { value: 'combined', label: 'Combined School' },
  { value: 'college', label: 'College' },
  { value: 'university', label: 'University' }
];

// Grading systems
export const GRADING_SYSTEMS = [
  { value: 'competency', label: 'Competency-Based' },
  { value: 'percentage', label: 'Percentage' },
  { value: 'letter', label: 'Letter Grade' },
  { value: 'gpa', label: 'GPA' }
];

// Helper function to get class options for a level
export const getClassOptions = (level) => {
  return LEVEL_CLASSES[level] || [];
};

// Helper function to get subject options for a level
export const getSubjectOptions = (level) => {
  return LEVEL_SUBJECTS[level] || [];
};

// Helper function to get level display name
export const getLevelDisplayName = (level) => {
  return LEVEL_DISPLAY_NAMES[level] || level || 'N/A';
};

// Helper function to get level badge class
export const getLevelBadgeClass = (level) => {
  return LEVEL_BADGE_CLASSES[level] || '';
};

// Year options: current year and 3 years back
export const getYearOptions = () => {
  const currentYear = new Date().getFullYear();
  return [currentYear, currentYear - 1, currentYear - 2, currentYear - 3];
};

// ============================================================
// Multi-paper assessment helpers
// ============================================================

/**
 * Compute a single paper's percentage contribution.
 * paper = { score, max, weight }
 *   - raw       = (score / max) * 100
 *   - weighted  = raw * (weight / 100)
 * Returns { raw, weighted } or null if invalid.
 */
export function paperPercentage(paper) {
  if (!paper) return null;
  const score = Number(paper.score);
  const max = Number(paper.max ?? paper.maxScore);
  if (!Number.isFinite(score) || !Number.isFinite(max) || max <= 0) return null;
  const raw = (score / max) * 100;
  const weight = Number(paper.weight) || 0;
  return { raw, weighted: (raw * weight) / 100 };
}

/**
 * Compute the final subject percentage from a papers object/array.
 * Auto-normalises if weights don't sum to 100.
 */
export function computePapersPercentage(papers) {
  if (!papers) return null;
  const list = Array.isArray(papers)
    ? papers
    : Object.entries(papers).map(([name, p]) => ({ name, ...p }));
  if (list.length === 0) return null;

  let weightedTotal = 0;
  let weightSum = 0;
  let valid = 0;

  for (const p of list) {
    const r = paperPercentage(p);
    if (!r) continue;
    weightedTotal += r.weighted;
    weightSum += Number(p.weight) || 0;
    valid++;
  }
  if (valid === 0) return null;
  if (weightSum > 0 && Math.abs(weightSum - 100) > 0.01) {
    return Math.round((weightedTotal / weightSum) * 100);
  }
  return Math.round(weightedTotal);
}

/**
 * Compute the final percentage for any score record.
 * Supports both single-score and multi-paper records.
 */
export function computeScorePercentage(record) {
  if (!record) return null;

  // Multi-paper record
  if (record.papers && typeof record.papers === 'object') {
    const pct = computePapersPercentage(record.papers);
    if (pct !== null) return pct;
  }

  // Prefer an explicit stored value
  if (Number.isFinite(Number(record.computedPercentage))) {
    return Math.round(Number(record.computedPercentage));
  }

  // Fall back to score/maxScore
  const score = Number(record.score);
  const max = Number(record.maxScore) || 100;
  if (!Number.isFinite(score) || max <= 0) return null;
  return Math.round((score / max) * 100);
}

/**
 * Validate a paper configuration.
 * Returns { valid, errors }.
 */
export function validatePaperConfig(papers) {
  const errors = [];
  if (!Array.isArray(papers) || papers.length === 0) {
    return { valid: true, errors }; // empty = single-paper subject
  }
  const names = new Set();
  let sum = 0;
  papers.forEach((p, i) => {
    const max = Number(p.maxScore ?? p.max);
    const weight = Number(p.weight);
    const name = String(p.name || '').trim();

    if (!name) errors.push(`Paper ${i + 1} needs a name`);
    else if (names.has(name)) errors.push(`Duplicate paper name "${name}"`);
    else names.add(name);

    if (!Number.isFinite(max) || max <= 0) {
      errors.push(`${name || `Paper ${i + 1}`}: max must be > 0`);
    }
    if (!Number.isFinite(weight) || weight < 0) {
      errors.push(`${name || `Paper ${i + 1}`}: weight must be ≥ 0`);
    }
    sum += Number.isFinite(weight) ? weight : 0;
  });
  if (Math.abs(sum - 100) > 0.01) {
    errors.push(`Weights must sum to 100 (currently ${sum})`);
  }
  return { valid: errors.length === 0, errors };
}
