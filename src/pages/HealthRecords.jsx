// src/pages/HealthRecords.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { db } from '../firebase';
import { 
  collection, query, where, getDocs, onSnapshot, doc, getDoc, 
  updateDoc, deleteDoc, addDoc, writeBatch, orderBy, serverTimestamp,
  increment, runTransaction
} from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';

import { showAppNotice } from '../utils/appNotice';
// Constants
const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown'];
const GENDER_TYPES = ['Male', 'Female'];

const VISIT_TYPES = {
  routine: 'Routine Checkup',
  emergency: 'Emergency',
  follow_up: 'Follow-up',
  immunization: 'Immunization',
  dental: 'Dental',
  eye: 'Eye Checkup',
  mental: 'Mental Health',
  referral: 'Referral',
  other: 'Other'
};

const TREATMENT_STATUS = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  referred: 'Referred',
  discharged: 'Discharged'
};

const TREATMENT_STATUS_COLORS = {
  pending: '#f39c12',
  in_progress: '#3498db',
  completed: '#27ae60',
  referred: '#e67e22',
  discharged: '#2c3e50'
};

const MEDICATION_TYPES = {
  prescribed: 'Prescribed',
  over_the_counter: 'Over The Counter',
  chronic: 'Chronic',
  emergency: 'Emergency'
};

const SEVERITY_LEVELS = {
  mild: 'Mild',
  moderate: 'Moderate',
  severe: 'Severe',
  critical: 'Critical'
};

const SEVERITY_COLORS = {
  mild: '#27ae60',
  moderate: '#f39c12',
  severe: '#e67e22',
  critical: '#e74c3c'
};

const ALLERGY_TYPES = {
  food: 'Food',
  medication: 'Medication',
  environmental: 'Environmental',
  insect: 'Insect',
  other: 'Other'
};

const ALLERGY_SEVERITY = {
  mild: 'Mild',
  moderate: 'Moderate',
  severe: 'Severe',
  life_threatening: 'Life Threatening'
};

export default function HealthRecords() {
  const navigate = useNavigate();
  const { currentUser, userData, userRole } = useAuth();
  const { isOnline, pendingCount, saveToIndexedDB, getFromIndexedDB, addToSyncQueue } = useSync();

  // State
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [modalType, setModalType] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteItem, setDeleteItem] = useState(null);
  const [deleteType, setDeleteType] = useState('');
  const [selectedStaff, setSelectedStaff] = useState(null);
  
  // Data states
  const [students, setStudents] = useState([]);
  const [healthRecords, setHealthRecords] = useState([]);
  const [prescriptions, setPrescriptions] = useState([]);
  const [allergies, setAllergies] = useState([]);
  const [immunizations, setImmunizations] = useState([]);
  const [visits, setVisits] = useState([]);
  const [medicalStaff, setMedicalStaff] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [notifications, setNotifications] = useState([]);
  
  // Filter states
  const [filterStudent, setFilterStudent] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [filterSeverity, setFilterSeverity] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  
  // Form states
  const [recordForm, setRecordForm] = useState({
    studentId: '',
    visitDate: new Date().toISOString().split('T')[0],
    visitType: 'routine',
    symptoms: '',
    diagnosis: '',
    treatment: '',
    severity: 'mild',
    status: 'pending',
    temperature: '',
    bloodPressure: '',
    weight: '',
    height: '',
    notes: '',
    referredTo: '',
    referralReason: '',
    followUpDate: ''
  });

  const [prescriptionForm, setPrescriptionForm] = useState({
    studentId: '',
    recordId: '',
    medication: '',
    dosage: '',
    frequency: '',
    route: 'oral',
    duration: '',
    type: 'prescribed',
    prescribedBy: '',
    prescribedDate: new Date().toISOString().split('T')[0],
    notes: ''
  });

  const [allergyForm, setAllergyForm] = useState({
    studentId: '',
    allergen: '',
    type: 'food',
    severity: 'moderate',
    reaction: '',
    diagnosedDate: new Date().toISOString().split('T')[0],
    notes: ''
  });

  const [immunizationForm, setImmunizationForm] = useState({
    studentId: '',
    vaccine: '',
    dose: '',
    date: new Date().toISOString().split('T')[0],
    nextDueDate: '',
    administeredBy: '',
    batchNumber: '',
    notes: ''
  });

  const [staffForm, setStaffForm] = useState({
    name: '',
    email: '',
    phone: '',
    role: 'nurse',
    qualification: '',
    licenseNumber: '',
    status: 'active',
    notes: ''
  });

  // Stats
  const [stats, setStats] = useState({
    totalStudents: 0,
    totalVisits: 0,
    pendingCases: 0,
    activeCases: 0,
    referrals: 0,
    immunizationsGiven: 0,
    commonDiagnosis: [],
    todayVisits: 0,
    inventoryItems: 0
  });

  // Refs
  const unsubscribeRef = useRef(null);

  // Load data on mount
  useEffect(() => {
    if (currentUser && userData) {
      loadData();
    }
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, [currentUser, userData, isOnline]);

  // Role-based access
  const isAdmin = userRole === 'admin' || userRole === 'super_admin' || userRole === 'user';
  const isMedicalStaff = userRole === 'nurse' || userRole === 'doctor' || userRole === 'health_worker';
  const isTeacher = userRole === 'teacher';
  const isStudent = userRole === 'student';
  const isParent = userRole === 'parent';

  const loadData = async () => {
    setLoading(true);
    try {
      const schoolId = userData?.schoolId || 'default_school';
      
      const [
        studentsData,
        recordsData,
        prescriptionsData,
        allergiesData,
        immunizationsData,
        visitsData,
        staffData,
        inventoryData
      ] = await Promise.all([
        loadCollection('students', schoolId),
        loadCollection('health_records', schoolId),
        loadCollection('prescriptions', schoolId),
        loadCollection('allergies', schoolId),
        loadCollection('immunizations', schoolId),
        loadCollection('visits', schoolId),
        loadCollection('medical_staff', schoolId),
        loadCollection('medical_inventory', schoolId)
      ]);

      setStudents(studentsData);
      setHealthRecords(recordsData);
      setPrescriptions(prescriptionsData);
      setAllergies(allergiesData);
      setImmunizations(immunizationsData);
      setVisits(visitsData);
      setMedicalStaff(staffData);
      setInventory(inventoryData);

      calculateStats(recordsData, visitsData, immunizationsData, inventoryData);
      setLoading(false);

      if (isOnline) {
        setupRealtimeListeners(schoolId);
      }

    } catch (error) {
      console.error('Error loading health data:', error);
      showNotification('Failed to load data', 'error');
      setLoading(false);
    }
  };

  const loadCollection = async (collectionName, schoolId) => {
    try {
      const cached = await getFromIndexedDB(`health_${collectionName}`);
      if (cached && cached.length > 0) {
        return cached;
      }

      if (isOnline) {
        const q = query(
          collection(db, collectionName),
          where('schoolId', '==', schoolId)
        );
        const snapshot = await getDocs(q);
        const data = [];
        snapshot.forEach(doc => {
          data.push({ id: doc.id, ...doc.data() });
        });
        await saveToIndexedDB(`health_${collectionName}`, data);
        return data;
      }

      return [];
    } catch (error) {
      console.error(`Error loading ${collectionName}:`, error);
      return [];
    }
  };

  const setupRealtimeListeners = (schoolId) => {
    const collections = ['health_records', 'prescriptions', 'allergies', 'immunizations', 'visits', 'medical_staff', 'medical_inventory'];
    
    collections.forEach(collectionName => {
      const q = query(
        collection(db, collectionName),
        where('schoolId', '==', schoolId)
      );
      
      const unsubscribe = onSnapshot(q, async (snapshot) => {
        const data = [];
        snapshot.forEach(doc => {
          data.push({ id: doc.id, ...doc.data() });
        });
        
        switch(collectionName) {
          case 'health_records':
            setHealthRecords(data);
            calculateStats(data, visits, immunizations, inventory);
            break;
          case 'prescriptions':
            setPrescriptions(data);
            break;
          case 'allergies':
            setAllergies(data);
            break;
          case 'immunizations':
            setImmunizations(data);
            calculateStats(healthRecords, visits, data, inventory);
            break;
          case 'visits':
            setVisits(data);
            calculateStats(healthRecords, data, immunizations, inventory);
            break;
          case 'medical_staff':
            setMedicalStaff(data);
            break;
          case 'medical_inventory':
            setInventory(data);
            calculateStats(healthRecords, visits, immunizations, data);
            break;
        }
        
        await saveToIndexedDB(`health_${collectionName}`, data);
      }, (error) => {
        console.error(`Listener error for ${collectionName}:`, error);
      });
      
      if (!unsubscribeRef.current) {
        unsubscribeRef.current = unsubscribe;
      }
    });
  };

  const calculateStats = (records, visitsData, immunizationsData, inventoryData) => {
    const totalVisits = records.length;
    const pendingCases = records.filter(r => r.status === 'pending').length;
    const activeCases = records.filter(r => r.status === 'in_progress').length;
    const referrals = records.filter(r => r.status === 'referred').length;
    
    const today = new Date().toISOString().split('T')[0];
    const todayVisits = records.filter(r => r.visitDate === today).length;
    
    // Common diagnosis
    const diagnosisCount = {};
    records.forEach(r => {
      if (r.diagnosis) {
        diagnosisCount[r.diagnosis] = (diagnosisCount[r.diagnosis] || 0) + 1;
      }
    });
    const commonDiagnosis = Object.entries(diagnosisCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    setStats({
      totalStudents: students.length,
      totalVisits,
      pendingCases,
      activeCases,
      referrals,
      immunizationsGiven: immunizationsData.length,
      commonDiagnosis,
      todayVisits,
      inventoryItems: inventoryData.length
    });
  };

  // Get tabs based on role
  const getAvailableTabs = () => {
    const tabs = [];
    
    tabs.push({ id: 'dashboard', label: 'Dashboard', icon: 'fa-chart-pie' });
    
    if (isAdmin || isMedicalStaff) {
      tabs.push({ id: 'records', label: 'Health Records', icon: 'fa-notes-medical' });
      tabs.push({ id: 'visits', label: 'Visits', icon: 'fa-user-md' });
      tabs.push({ id: 'prescriptions', label: 'Prescriptions', icon: 'fa-prescription-bottle' });
      tabs.push({ id: 'allergies', label: 'Allergies', icon: 'fa-allergies' });
      tabs.push({ id: 'immunizations', label: 'Immunizations', icon: 'fa-syringe' });
      tabs.push({ id: 'staff', label: 'Medical Staff', icon: 'fa-user-nurse' });
      tabs.push({ id: 'inventory', label: 'Inventory', icon: 'fa-boxes' });
    }
    
    if (isStudent) {
      tabs.push({ id: 'my-records', label: 'My Records', icon: 'fa-user' });
    }
    
    if (isParent) {
      tabs.push({ id: 'child-records', label: 'Child Records', icon: 'fa-child' });
    }
    
    return tabs;
  };

  const tabs = getAvailableTabs();

  // Notification helper
  const showNotification = (message, type = 'info') => {
        showAppNotice(message, type);
    };

  // Health Record CRUD
  const handleAddRecord = async () => {
    try {
      const student = students.find(s => s.id === recordForm.studentId);
      const data = {
        ...recordForm,
        studentName: `${student?.firstName || ''} ${student?.lastName || ''}`.trim() || 'Unknown',
        studentClass: student?.class || 'N/A',
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'health_records'), data);
      } else {
        await addToSyncQueue('health_records', 'add', data);
        const updatedRecords = [data, ...healthRecords];
        setHealthRecords(updatedRecords);
        await saveToIndexedDB('health_health_records', updatedRecords);
      }

      showNotification('Health record added successfully!', 'success');
      setShowModal(false);
      resetRecordForm();
    } catch (error) {
      console.error('Error adding health record:', error);
      showNotification('Failed to add health record', 'error');
    }
  };

  const handleUpdateRecord = async () => {
    try {
      const data = {
        ...recordForm,
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await updateDoc(doc(db, 'health_records', selectedRecord.id), data);
      } else {
        await addToSyncQueue('health_records', 'update', { id: selectedRecord.id, ...data });
      }

      const updatedRecords = healthRecords.map(r => 
        r.id === selectedRecord.id ? { ...r, ...data } : r
      );
      setHealthRecords(updatedRecords);
      await saveToIndexedDB('health_health_records', updatedRecords);

      showNotification('Health record updated successfully!', 'success');
      setShowModal(false);
      setSelectedRecord(null);
      resetRecordForm();
    } catch (error) {
      console.error('Error updating health record:', error);
      showNotification('Failed to update health record', 'error');
    }
  };

  // Prescription CRUD
  const handleAddPrescription = async () => {
    try {
      const data = {
        ...prescriptionForm,
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'prescriptions'), data);
      } else {
        await addToSyncQueue('prescriptions', 'add', data);
        const updatedPrescriptions = [data, ...prescriptions];
        setPrescriptions(updatedPrescriptions);
        await saveToIndexedDB('health_prescriptions', updatedPrescriptions);
      }

      showNotification('Prescription added successfully!', 'success');
      setShowModal(false);
      resetPrescriptionForm();
    } catch (error) {
      console.error('Error adding prescription:', error);
      showNotification('Failed to add prescription', 'error');
    }
  };

  // Allergy CRUD
  const handleAddAllergy = async () => {
    try {
      const student = students.find(s => s.id === allergyForm.studentId);
      const data = {
        ...allergyForm,
        studentName: `${student?.firstName || ''} ${student?.lastName || ''}`.trim() || 'Unknown',
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'allergies'), data);
      } else {
        await addToSyncQueue('allergies', 'add', data);
        const updatedAllergies = [data, ...allergies];
        setAllergies(updatedAllergies);
        await saveToIndexedDB('health_allergies', updatedAllergies);
      }

      showNotification('Allergy recorded successfully!', 'success');
      setShowModal(false);
      resetAllergyForm();
    } catch (error) {
      console.error('Error adding allergy:', error);
      showNotification('Failed to add allergy', 'error');
    }
  };

  // Immunization CRUD
  const handleAddImmunization = async () => {
    try {
      const student = students.find(s => s.id === immunizationForm.studentId);
      const data = {
        ...immunizationForm,
        studentName: `${student?.firstName || ''} ${student?.lastName || ''}`.trim() || 'Unknown',
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'immunizations'), data);
      } else {
        await addToSyncQueue('immunizations', 'add', data);
        const updatedImmunizations = [data, ...immunizations];
        setImmunizations(updatedImmunizations);
        await saveToIndexedDB('health_immunizations', updatedImmunizations);
      }

      showNotification('Immunization recorded successfully!', 'success');
      setShowModal(false);
      resetImmunizationForm();
    } catch (error) {
      console.error('Error adding immunization:', error);
      showNotification('Failed to add immunization', 'error');
    }
  };

  // Staff CRUD
  const handleAddStaff = async () => {
    try {
      const data = {
        ...staffForm,
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'medical_staff'), data);
      } else {
        await addToSyncQueue('medical_staff', 'add', data);
        const updatedStaff = [data, ...medicalStaff];
        setMedicalStaff(updatedStaff);
        await saveToIndexedDB('health_medical_staff', updatedStaff);
      }

      showNotification('Medical staff added successfully!', 'success');
      setShowModal(false);
      resetStaffForm();
    } catch (error) {
      console.error('Error adding medical staff:', error);
      showNotification('Failed to add medical staff', 'error');
    }
  };

const handleUpdateStaff = async () => {
    try {
        const data = {
            ...staffForm,
            updatedAt: new Date().toISOString()
        };

        if (isOnline) {
            await updateDoc(doc(db, 'medical_staff', selectedStaff.id), data);
        } else {
            await addToSyncQueue('medical_staff', 'update', { id: selectedStaff.id, ...data });
        }

        const updatedStaff = medicalStaff.map(s => 
            s.id === selectedStaff.id ? { ...s, ...data } : s
        );
        setMedicalStaff(updatedStaff);
        await saveToIndexedDB('health_medical_staff', updatedStaff);

        showNotification('Staff updated successfully!', 'success');
        setShowModal(false);
        setSelectedStaff(null);
        resetStaffForm();
    } catch (error) {
        console.error('Error updating staff:', error);
        showNotification('Failed to update staff', 'error');
    }
};

  // Form reset functions
  const resetRecordForm = () => {
    setRecordForm({
      studentId: '',
      visitDate: new Date().toISOString().split('T')[0],
      visitType: 'routine',
      symptoms: '',
      diagnosis: '',
      treatment: '',
      severity: 'mild',
      status: 'pending',
      temperature: '',
      bloodPressure: '',
      weight: '',
      height: '',
      notes: '',
      referredTo: '',
      referralReason: '',
      followUpDate: ''
    });
  };

  const resetPrescriptionForm = () => {
    setPrescriptionForm({
      studentId: '',
      recordId: '',
      medication: '',
      dosage: '',
      frequency: '',
      route: 'oral',
      duration: '',
      type: 'prescribed',
      prescribedBy: '',
      prescribedDate: new Date().toISOString().split('T')[0],
      notes: ''
    });
  };

  const resetAllergyForm = () => {
    setAllergyForm({
      studentId: '',
      allergen: '',
      type: 'food',
      severity: 'moderate',
      reaction: '',
      diagnosedDate: new Date().toISOString().split('T')[0],
      notes: ''
    });
  };

  const resetImmunizationForm = () => {
    setImmunizationForm({
      studentId: '',
      vaccine: '',
      dose: '',
      date: new Date().toISOString().split('T')[0],
      nextDueDate: '',
      administeredBy: '',
      batchNumber: '',
      notes: ''
    });
  };

  const resetStaffForm = () => {
    setStaffForm({
      name: '',
      email: '',
      phone: '',
      role: 'nurse',
      qualification: '',
      licenseNumber: '',
      status: 'active',
      notes: ''
    });
  };

  // Render Dashboard
  const renderDashboard = () => (
    <>
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total Students</div>
          <div className="stat-value">{stats.totalStudents}</div>
        </div>
        <div className="stat-card" onClick={() => setActiveTab('records')} style={{ cursor: 'pointer' }}>
          <div className="stat-label">Total Visits</div>
          <div className="stat-value">{stats.totalVisits}</div>
          <div className="stat-sub">{stats.todayVisits} Today</div>
        </div>
        <div className="stat-card" onClick={() => setActiveTab('records')} style={{ cursor: 'pointer' }}>
          <div className="stat-label">Active Cases</div>
          <div className="stat-value" style={{ color: '#3498db' }}>{stats.activeCases}</div>
          <div className="stat-sub">{stats.pendingCases} Pending</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Referrals</div>
          <div className="stat-value" style={{ color: '#e67e22' }}>{stats.referrals}</div>
        </div>
        <div className="stat-card" onClick={() => setActiveTab('immunizations')} style={{ cursor: 'pointer' }}>
          <div className="stat-label">Immunizations Given</div>
          <div className="stat-value">{stats.immunizationsGiven}</div>
        </div>
        <div className="stat-card" onClick={() => setActiveTab('inventory')} style={{ cursor: 'pointer' }}>
          <div className="stat-label">Inventory Items</div>
          <div className="stat-value">{stats.inventoryItems}</div>
        </div>
      </div>

      {/* Common Diagnosis */}
      {stats.commonDiagnosis.length > 0 && (
        <div className="diagnosis-section">
          <h3>Common Diagnosis</h3>
          <div className="diagnosis-list">
            {stats.commonDiagnosis.map((item, index) => (
              <div key={index} className="diagnosis-item">
                <span className="diagnosis-name">{item.name}</span>
                <span className="diagnosis-count">{item.count} cases</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="recent-activity">
        <h3>Recent Activity</h3>
        <div className="activity-list">
          {notifications.slice(0, 5).map((note, index) => (
            <div key={index} className="activity-item">
              <div className="activity-icon">
                <i className={`fas fa-${note.icon || 'info-circle'}`}></i>
              </div>
              <div className="activity-content">
                <div className="text">{note.message}</div>
                <div className="time">{new Date(note.timestamp).toLocaleDateString()}</div>
              </div>
            </div>
          ))}
          {notifications.length === 0 && (
            <div className="empty-state">
              <p>No recent activity</p>
            </div>
          )}
        </div>
      </div>
    </>
  );

  // Render Health Records
  const renderRecords = () => (
    <div className="records-section">
      <div className="section-header">
        <h2>Health Records</h2>
        {(isAdmin || isMedicalStaff) && (
          <button className="btn btn-primary" onClick={() => {
            setModalType('record');
            resetRecordForm();
            setShowModal(true);
          }}>
            <i className="fas fa-plus"></i> Add Record
          </button>
        )}
      </div>

      <div className="filters-section">
        <input
          type="text"
          className="search-input"
          placeholder="Search by student name or diagnosis..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <select
          className="filter-select"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">All Status</option>
          {Object.entries(TREATMENT_STATUS).map(([key, value]) => (
            <option key={key} value={key}>{value}</option>
          ))}
        </select>
        <select
          className="filter-select"
          value={filterSeverity}
          onChange={(e) => setFilterSeverity(e.target.value)}
        >
          <option value="">All Severity</option>
          {Object.entries(SEVERITY_LEVELS).map(([key, value]) => (
            <option key={key} value={key}>{value}</option>
          ))}
        </select>
        <input
          type="date"
          className="filter-select"
          value={filterDate}
          onChange={(e) => setFilterDate(e.target.value)}
        />
      </div>

      <div className="records-grid">
        {healthRecords
          .filter(r => {
            const student = students.find(s => s.id === r.studentId);
            const matchSearch = (student?.firstName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                              (student?.lastName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                              (r.diagnosis || '').toLowerCase().includes(searchTerm.toLowerCase());
            const matchStatus = !filterStatus || r.status === filterStatus;
            const matchSeverity = !filterSeverity || r.severity === filterSeverity;
            const matchDate = !filterDate || r.visitDate === filterDate;
            return matchSearch && matchStatus && matchSeverity && matchDate;
          })
          .map(record => {
            const student = students.find(s => s.id === record.studentId);
            return (
              <div key={record.id} className="record-card">
                <div className="record-header">
                  <div>
                    <h3>{student ? `${student.firstName} ${student.lastName}` : 'Unknown'}</h3>
                    <p className="student-class">{student?.class || 'N/A'}</p>
                  </div>
                  <span className="record-status" style={{
                    background: TREATMENT_STATUS_COLORS[record.status] + '20',
                    color: TREATMENT_STATUS_COLORS[record.status]
                  }}>
                    {TREATMENT_STATUS[record.status] || record.status}
                  </span>
                </div>
                <div className="record-details">
                  <p><i className="fas fa-calendar"></i> {new Date(record.visitDate).toLocaleDateString()}</p>
                  <p><i className="fas fa-stethoscope"></i> {VISIT_TYPES[record.visitType] || record.visitType}</p>
                  <p><i className="fas fa-exclamation-triangle"></i> Severity: {SEVERITY_LEVELS[record.severity]}</p>
                  {record.diagnosis && (
                    <p><strong>Diagnosis:</strong> {record.diagnosis}</p>
                  )}
                  {record.temperature && (
                    <p><i className="fas fa-thermometer-half"></i> Temp: {record.temperature}°C</p>
                  )}
                  {record.bloodPressure && (
                    <p><i className="fas fa-heart"></i> BP: {record.bloodPressure}</p>
                  )}
                  {record.referredTo && (
                    <p><i className="fas fa-ambulance"></i> Referred to: {record.referredTo}</p>
                  )}
                </div>
                <div className="record-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => {
                    setSelectedRecord(record);
                    setModalType('record');
                    setRecordForm(record);
                    setShowModal(true);
                  }}>
                    <i className="fas fa-edit"></i> Edit
                  </button>
                  <button className="btn btn-success btn-sm" onClick={() => {
                    setModalType('prescription');
                    resetPrescriptionForm();
                    setPrescriptionForm(prev => ({ 
                      ...prev, 
                      studentId: record.studentId,
                      recordId: record.id 
                    }));
                    setShowModal(true);
                  }}>
                    <i className="fas fa-prescription"></i> Prescribe
                  </button>
                  <button className="btn btn-info btn-sm" onClick={() => {
                    // View full record details
                  }}>
                    <i className="fas fa-eye"></i> View
                  </button>
                </div>
              </div>
            );
          })}
        {healthRecords.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-notes-medical"></i>
            <p>No health records found</p>
          </div>
        )}
      </div>
    </div>
  );

  // Render Prescriptions
  const renderPrescriptions = () => (
    <div className="prescriptions-section">
      <div className="section-header">
        <h2>Prescriptions</h2>
        {(isAdmin || isMedicalStaff) && (
          <button className="btn btn-primary" onClick={() => {
            setModalType('prescription');
            resetPrescriptionForm();
            setShowModal(true);
          }}>
            <i className="fas fa-plus"></i> Add Prescription
          </button>
        )}
      </div>

      <div className="prescriptions-grid">
        {prescriptions.map(prescription => {
          const student = students.find(s => s.id === prescription.studentId);
          return (
            <div key={prescription.id} className="prescription-card">
              <div className="prescription-header">
                <h3>{student ? `${student.firstName} ${student.lastName}` : 'Unknown'}</h3>
                <span className="prescription-type">{MEDICATION_TYPES[prescription.type]}</span>
              </div>
              <div className="prescription-details">
                <p><strong>Medication:</strong> {prescription.medication}</p>
                <p><strong>Dosage:</strong> {prescription.dosage}</p>
                <p><strong>Frequency:</strong> {prescription.frequency}</p>
                <p><strong>Route:</strong> {prescription.route}</p>
                <p><strong>Duration:</strong> {prescription.duration}</p>
                <p><strong>Prescribed:</strong> {new Date(prescription.prescribedDate).toLocaleDateString()}</p>
                {prescription.notes && (
                  <p><strong>Notes:</strong> {prescription.notes}</p>
                )}
              </div>
            </div>
          );
        })}
        {prescriptions.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-prescription-bottle"></i>
            <p>No prescriptions found</p>
          </div>
        )}
      </div>
    </div>
  );

  // Render Allergies
  const renderAllergies = () => (
    <div className="allergies-section">
      <div className="section-header">
        <h2>Allergies</h2>
        {(isAdmin || isMedicalStaff) && (
          <button className="btn btn-primary" onClick={() => {
            setModalType('allergy');
            resetAllergyForm();
            setShowModal(true);
          }}>
            <i className="fas fa-plus"></i> Add Allergy
          </button>
        )}
      </div>

      <div className="allergies-grid">
        {allergies.map(allergy => {
          const student = students.find(s => s.id === allergy.studentId);
          return (
            <div key={allergy.id} className="allergy-card">
              <div className="allergy-header">
                <h3>{student ? `${student.firstName} ${student.lastName}` : 'Unknown'}</h3>
                <span className="allergy-severity" style={{
                  background: allergy.severity === 'life_threatening' ? '#e74c3c' :
                             allergy.severity === 'severe' ? '#e67e22' :
                             allergy.severity === 'moderate' ? '#f39c12' : '#27ae60'
                }}>
                  {ALLERGY_SEVERITY[allergy.severity]}
                </span>
              </div>
              <div className="allergy-details">
                <p><strong>Allergen:</strong> {allergy.allergen}</p>
                <p><strong>Type:</strong> {ALLERGY_TYPES[allergy.type]}</p>
                <p><strong>Reaction:</strong> {allergy.reaction || 'N/A'}</p>
                <p><strong>Diagnosed:</strong> {new Date(allergy.diagnosedDate).toLocaleDateString()}</p>
                {allergy.notes && (
                  <p><strong>Notes:</strong> {allergy.notes}</p>
                )}
              </div>
            </div>
          );
        })}
        {allergies.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-allergies"></i>
            <p>No allergies recorded</p>
          </div>
        )}
      </div>
    </div>
  );

  // Render Immunizations
  const renderImmunizations = () => (
    <div className="immunizations-section">
      <div className="section-header">
        <h2>Immunizations</h2>
        {(isAdmin || isMedicalStaff) && (
          <button className="btn btn-primary" onClick={() => {
            setModalType('immunization');
            resetImmunizationForm();
            setShowModal(true);
          }}>
            <i className="fas fa-plus"></i> Add Immunization
          </button>
        )}
      </div>

      <div className="immunizations-grid">
        {immunizations.map(immunization => {
          const student = students.find(s => s.id === immunization.studentId);
          return (
            <div key={immunization.id} className="immunization-card">
              <div className="immunization-header">
                <h3>{student ? `${student.firstName} ${student.lastName}` : 'Unknown'}</h3>
                <span className="immunization-vaccine">{immunization.vaccine}</span>
              </div>
              <div className="immunization-details">
                <p><strong>Dose:</strong> {immunization.dose}</p>
                <p><strong>Date:</strong> {new Date(immunization.date).toLocaleDateString()}</p>
                {immunization.nextDueDate && (
                  <p><strong>Next Due:</strong> {new Date(immunization.nextDueDate).toLocaleDateString()}</p>
                )}
                <p><strong>Administered By:</strong> {immunization.administeredBy || 'N/A'}</p>
                {immunization.batchNumber && (
                  <p><strong>Batch:</strong> {immunization.batchNumber}</p>
                )}
                {immunization.notes && (
                  <p><strong>Notes:</strong> {immunization.notes}</p>
                )}
              </div>
            </div>
          );
        })}
        {immunizations.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-syringe"></i>
            <p>No immunizations recorded</p>
          </div>
        )}
      </div>
    </div>
  );

  // Render Medical Staff
  const renderStaff = () => (
    <div className="staff-section">
      <div className="section-header">
        <h2>Medical Staff</h2>
        {(isAdmin || isMedicalStaff) && (
          <button className="btn btn-primary" onClick={() => {
            setModalType('staff');
            resetStaffForm();
            setShowModal(true);
          }}>
            <i className="fas fa-plus"></i> Add Staff
          </button>
        )}
      </div>

      <div className="staff-grid">
        {medicalStaff.map(staff => (
          <div key={staff.id} className="staff-card">
            <div className="staff-header">
              <div className="staff-avatar">
                {(staff.name || 'S')[0].toUpperCase()}
              </div>
              <div>
                <h3>{staff.name}</h3>
                <p>{staff.role}</p>
              </div>
              <span className={`staff-status ${staff.status}`}>
                {staff.status}
              </span>
            </div>
            <div className="staff-details">
              <p><i className="fas fa-envelope"></i> {staff.email}</p>
              <p><i className="fas fa-phone"></i> {staff.phone}</p>
              <p><i className="fas fa-graduation-cap"></i> {staff.qualification}</p>
              <p><i className="fas fa-id-card"></i> License: {staff.licenseNumber}</p>
              {staff.notes && (
                <p><i className="fas fa-sticky-note"></i> {staff.notes}</p>
              )}
            </div>
            {(isAdmin || isMedicalStaff) && (
              <div className="staff-actions">
                <button className="btn btn-primary btn-sm" onClick={() => {
                  setSelectedStaff(staff);
                  setModalType('staff');
                  setStaffForm(staff);
                  setShowModal(true);
                }}>
                  <i className="fas fa-edit"></i> Edit
                </button>
              </div>
            )}
          </div>
        ))}
        {medicalStaff.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-user-nurse"></i>
            <p>No medical staff registered</p>
          </div>
        )}
      </div>
    </div>
  );

  // Render My Records (Student view)
  const renderMyRecords = () => {
    const student = students.find(s => s.id === currentUser?.uid || s.email === currentUser?.email);
    const myRecords = healthRecords.filter(r => r.studentId === student?.id);
    const myAllergies = allergies.filter(a => a.studentId === student?.id);
    const myImmunizations = immunizations.filter(i => i.studentId === student?.id);
    const myPrescriptions = prescriptions.filter(p => p.studentId === student?.id);

    return (
      <div className="my-records-section">
        <h2>My Health Records</h2>
        
        <div className="student-health-summary">
          <div className="health-summary-card">
            <h4>My Allergies</h4>
            {myAllergies.length === 0 ? (
              <p className="no-data">No allergies recorded</p>
            ) : (
              myAllergies.map(allergy => (
                <div key={allergy.id} className="allergy-item">
                  <span className="allergen">{allergy.allergen}</span>
                  <span className="allergy-severity-badge" style={{
                    background: allergy.severity === 'life_threatening' ? '#e74c3c' :
                               allergy.severity === 'severe' ? '#e67e22' :
                               allergy.severity === 'moderate' ? '#f39c12' : '#27ae60'
                  }}>
                    {ALLERGY_SEVERITY[allergy.severity]}
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="health-summary-card">
            <h4>Recent Visits</h4>
            {myRecords.length === 0 ? (
              <p className="no-data">No health records</p>
            ) : (
              myRecords.slice(0, 5).map(record => (
                <div key={record.id} className="visit-item">
                  <div className="visit-date">{new Date(record.visitDate).toLocaleDateString()}</div>
                  <div className="visit-diagnosis">{record.diagnosis || 'No diagnosis'}</div>
                  <span className={`visit-status ${record.status}`}>
                    {TREATMENT_STATUS[record.status]}
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="health-summary-card">
            <h4>Immunizations</h4>
            {myImmunizations.length === 0 ? (
              <p className="no-data">No immunizations recorded</p>
            ) : (
              myImmunizations.map(immunization => (
                <div key={immunization.id} className="immunization-item">
                  <span className="vaccine">{immunization.vaccine}</span>
                  <span className="immunization-date">{new Date(immunization.date).toLocaleDateString()}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {myRecords.length > 0 && (
          <div className="full-records">
            <h3>All Health Records</h3>
            {myRecords.map(record => (
              <div key={record.id} className="record-item">
                <div className="record-item-header">
                  <span className="record-date">{new Date(record.visitDate).toLocaleDateString()}</span>
                  <span className="record-type">{VISIT_TYPES[record.visitType]}</span>
                  <span className={`record-status ${record.status}`}>
                    {TREATMENT_STATUS[record.status]}
                  </span>
                </div>
                <div className="record-item-details">
                  {record.symptoms && <p><strong>Symptoms:</strong> {record.symptoms}</p>}
                  {record.diagnosis && <p><strong>Diagnosis:</strong> {record.diagnosis}</p>}
                  {record.treatment && <p><strong>Treatment:</strong> {record.treatment}</p>}
                  {record.notes && <p><strong>Notes:</strong> {record.notes}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // Modal render function
  const renderModal = () => {
    switch(modalType) {
      case 'record':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>{selectedRecord ? 'Edit Health Record' : 'Add Health Record'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              selectedRecord ? handleUpdateRecord() : handleAddRecord();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Student <span className="required">*</span></label>
                  <select
                    value={recordForm.studentId}
                    onChange={(e) => setRecordForm({ ...recordForm, studentId: e.target.value })}
                    required
                  >
                    <option value="">Select Student</option>
                    {students.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.firstName} {s.lastName} - {s.class}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Visit Date</label>
                  <input
                    type="date"
                    value={recordForm.visitDate}
                    onChange={(e) => setRecordForm({ ...recordForm, visitDate: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Visit Type</label>
                  <select
                    value={recordForm.visitType}
                    onChange={(e) => setRecordForm({ ...recordForm, visitType: e.target.value })}
                  >
                    {Object.entries(VISIT_TYPES).map(([key, value]) => (
                      <option key={key} value={key}>{value}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Severity</label>
                  <select
                    value={recordForm.severity}
                    onChange={(e) => setRecordForm({ ...recordForm, severity: e.target.value })}
                  >
                    {Object.entries(SEVERITY_LEVELS).map(([key, value]) => (
                      <option key={key} value={key}>{value}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Temperature (°C)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={recordForm.temperature}
                    onChange={(e) => setRecordForm({ ...recordForm, temperature: e.target.value })}
                    placeholder="36.5"
                  />
                </div>
                <div className="form-group">
                  <label>Blood Pressure</label>
                  <input
                    type="text"
                    value={recordForm.bloodPressure}
                    onChange={(e) => setRecordForm({ ...recordForm, bloodPressure: e.target.value })}
                    placeholder="120/80"
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Weight (kg)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={recordForm.weight}
                    onChange={(e) => setRecordForm({ ...recordForm, weight: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Height (cm)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={recordForm.height}
                    onChange={(e) => setRecordForm({ ...recordForm, height: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Symptoms</label>
                <textarea
                  value={recordForm.symptoms}
                  onChange={(e) => setRecordForm({ ...recordForm, symptoms: e.target.value })}
                  rows="2"
                  placeholder="Describe symptoms"
                />
              </div>
              <div className="form-group">
                <label>Diagnosis</label>
                <input
                  type="text"
                  value={recordForm.diagnosis}
                  onChange={(e) => setRecordForm({ ...recordForm, diagnosis: e.target.value })}
                  placeholder="Diagnosis"
                />
              </div>
              <div className="form-group">
                <label>Treatment</label>
                <textarea
                  value={recordForm.treatment}
                  onChange={(e) => setRecordForm({ ...recordForm, treatment: e.target.value })}
                  rows="2"
                  placeholder="Treatment plan"
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Status</label>
                  <select
                    value={recordForm.status}
                    onChange={(e) => setRecordForm({ ...recordForm, status: e.target.value })}
                  >
                    {Object.entries(TREATMENT_STATUS).map(([key, value]) => (
                      <option key={key} value={key}>{value}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Follow-up Date</label>
                  <input
                    type="date"
                    value={recordForm.followUpDate}
                    onChange={(e) => setRecordForm({ ...recordForm, followUpDate: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Referred To</label>
                  <input
                    type="text"
                    value={recordForm.referredTo}
                    onChange={(e) => setRecordForm({ ...recordForm, referredTo: e.target.value })}
                    placeholder="Hospital or specialist"
                  />
                </div>
                <div className="form-group">
                  <label>Referral Reason</label>
                  <input
                    type="text"
                    value={recordForm.referralReason}
                    onChange={(e) => setRecordForm({ ...recordForm, referralReason: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={recordForm.notes}
                  onChange={(e) => setRecordForm({ ...recordForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {selectedRecord ? 'Update' : 'Add'} Record
                </button>
              </div>
            </form>
          </div>
        );

      case 'prescription':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>Add Prescription</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              handleAddPrescription();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Student <span className="required">*</span></label>
                  <select
                    value={prescriptionForm.studentId}
                    onChange={(e) => setPrescriptionForm({ ...prescriptionForm, studentId: e.target.value })}
                    required
                  >
                    <option value="">Select Student</option>
                    {students.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.firstName} {s.lastName} - {s.class}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Medication <span className="required">*</span></label>
                  <input
                    type="text"
                    value={prescriptionForm.medication}
                    onChange={(e) => setPrescriptionForm({ ...prescriptionForm, medication: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Dosage <span className="required">*</span></label>
                  <input
                    type="text"
                    value={prescriptionForm.dosage}
                    onChange={(e) => setPrescriptionForm({ ...prescriptionForm, dosage: e.target.value })}
                    required
                    placeholder="e.g., 500mg"
                  />
                </div>
                <div className="form-group">
                  <label>Frequency <span className="required">*</span></label>
                  <input
                    type="text"
                    value={prescriptionForm.frequency}
                    onChange={(e) => setPrescriptionForm({ ...prescriptionForm, frequency: e.target.value })}
                    required
                    placeholder="e.g., Twice daily"
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Route</label>
                  <select
                    value={prescriptionForm.route}
                    onChange={(e) => setPrescriptionForm({ ...prescriptionForm, route: e.target.value })}
                  >
                    <option value="oral">Oral</option>
                    <option value="topical">Topical</option>
                    <option value="injection">Injection</option>
                    <option value="inhalation">Inhalation</option>
                    <option value="sublingual">Sublingual</option>
                    <option value="rectal">Rectal</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Duration</label>
                  <input
                    type="text"
                    value={prescriptionForm.duration}
                    onChange={(e) => setPrescriptionForm({ ...prescriptionForm, duration: e.target.value })}
                    placeholder="e.g., 7 days"
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Type</label>
                  <select
                    value={prescriptionForm.type}
                    onChange={(e) => setPrescriptionForm({ ...prescriptionForm, type: e.target.value })}
                  >
                    {Object.entries(MEDICATION_TYPES).map(([key, value]) => (
                      <option key={key} value={key}>{value}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Prescribed By</label>
                  <input
                    type="text"
                    value={prescriptionForm.prescribedBy}
                    onChange={(e) => setPrescriptionForm({ ...prescriptionForm, prescribedBy: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={prescriptionForm.notes}
                  onChange={(e) => setPrescriptionForm({ ...prescriptionForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Add Prescription
                </button>
              </div>
            </form>
          </div>
        );

      case 'allergy':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>Record Allergy</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              handleAddAllergy();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Student <span className="required">*</span></label>
                  <select
                    value={allergyForm.studentId}
                    onChange={(e) => setAllergyForm({ ...allergyForm, studentId: e.target.value })}
                    required
                  >
                    <option value="">Select Student</option>
                    {students.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.firstName} {s.lastName} - {s.class}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Allergen <span className="required">*</span></label>
                  <input
                    type="text"
                    value={allergyForm.allergen}
                    onChange={(e) => setAllergyForm({ ...allergyForm, allergen: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Type</label>
                  <select
                    value={allergyForm.type}
                    onChange={(e) => setAllergyForm({ ...allergyForm, type: e.target.value })}
                  >
                    {Object.entries(ALLERGY_TYPES).map(([key, value]) => (
                      <option key={key} value={key}>{value}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Severity <span className="required">*</span></label>
                  <select
                    value={allergyForm.severity}
                    onChange={(e) => setAllergyForm({ ...allergyForm, severity: e.target.value })}
                    required
                  >
                    {Object.entries(ALLERGY_SEVERITY).map(([key, value]) => (
                      <option key={key} value={key}>{value}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Reaction</label>
                <textarea
                  value={allergyForm.reaction}
                  onChange={(e) => setAllergyForm({ ...allergyForm, reaction: e.target.value })}
                  rows="2"
                  placeholder="Describe the reaction"
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Diagnosed Date</label>
                  <input
                    type="date"
                    value={allergyForm.diagnosedDate}
                    onChange={(e) => setAllergyForm({ ...allergyForm, diagnosedDate: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={allergyForm.notes}
                  onChange={(e) => setAllergyForm({ ...allergyForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Record Allergy
                </button>
              </div>
            </form>
          </div>
        );

      case 'immunization':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>Record Immunization</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              handleAddImmunization();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Student <span className="required">*</span></label>
                  <select
                    value={immunizationForm.studentId}
                    onChange={(e) => setImmunizationForm({ ...immunizationForm, studentId: e.target.value })}
                    required
                  >
                    <option value="">Select Student</option>
                    {students.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.firstName} {s.lastName} - {s.class}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Vaccine <span className="required">*</span></label>
                  <input
                    type="text"
                    value={immunizationForm.vaccine}
                    onChange={(e) => setImmunizationForm({ ...immunizationForm, vaccine: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Dose <span className="required">*</span></label>
                  <input
                    type="text"
                    value={immunizationForm.dose}
                    onChange={(e) => setImmunizationForm({ ...immunizationForm, dose: e.target.value })}
                    required
                    placeholder="e.g., 1st dose"
                  />
                </div>
                <div className="form-group">
                  <label>Date <span className="required">*</span></label>
                  <input
                    type="date"
                    value={immunizationForm.date}
                    onChange={(e) => setImmunizationForm({ ...immunizationForm, date: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Next Due Date</label>
                  <input
                    type="date"
                    value={immunizationForm.nextDueDate}
                    onChange={(e) => setImmunizationForm({ ...immunizationForm, nextDueDate: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Administered By</label>
                  <input
                    type="text"
                    value={immunizationForm.administeredBy}
                    onChange={(e) => setImmunizationForm({ ...immunizationForm, administeredBy: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Batch Number</label>
                  <input
                    type="text"
                    value={immunizationForm.batchNumber}
                    onChange={(e) => setImmunizationForm({ ...immunizationForm, batchNumber: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={immunizationForm.notes}
                  onChange={(e) => setImmunizationForm({ ...immunizationForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Record Immunization
                </button>
              </div>
            </form>
          </div>
        );

      case 'staff':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>{selectedStaff ? 'Edit Staff' : 'Add Medical Staff'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              selectedStaff ? handleUpdateStaff() : handleAddStaff();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Full Name <span className="required">*</span></label>
                  <input
                    type="text"
                    value={staffForm.name}
                    onChange={(e) => setStaffForm({ ...staffForm, name: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Email <span className="required">*</span></label>
                  <input
                    type="email"
                    value={staffForm.email}
                    onChange={(e) => setStaffForm({ ...staffForm, email: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Phone <span className="required">*</span></label>
                  <input
                    type="tel"
                    value={staffForm.phone}
                    onChange={(e) => setStaffForm({ ...staffForm, phone: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Role <span className="required">*</span></label>
                  <select
                    value={staffForm.role}
                    onChange={(e) => setStaffForm({ ...staffForm, role: e.target.value })}
                    required
                  >
                    <option value="nurse">Nurse</option>
                    <option value="doctor">Doctor</option>
                    <option value="health_worker">Health Worker</option>
                    <option value="pharmacist">Pharmacist</option>
                    <option value="lab_technician">Lab Technician</option>
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Qualification</label>
                  <input
                    type="text"
                    value={staffForm.qualification}
                    onChange={(e) => setStaffForm({ ...staffForm, qualification: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>License Number</label>
                  <input
                    type="text"
                    value={staffForm.licenseNumber}
                    onChange={(e) => setStaffForm({ ...staffForm, licenseNumber: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Status</label>
                <select
                  value={staffForm.status}
                  onChange={(e) => setStaffForm({ ...staffForm, status: e.target.value })}
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="on_leave">On Leave</option>
                </select>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={staffForm.notes}
                  onChange={(e) => setStaffForm({ ...staffForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {selectedStaff ? 'Update' : 'Add'} Staff
                </button>
              </div>
            </form>
          </div>
        );

      default:
        return null;
    }
  };

  if (loading) {
    return <LoadingSpinner fullScreen text="Loading health records..." />;
  }

  return (
    <Layout title="Health Records Management">
      <style>{`
        .health-container {
          padding: 0;
        }

        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 20px;
          margin-bottom: 30px;
        }

        .stat-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
          transition: all 0.3s;
        }

        .stat-card:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-lg);
        }

        .stat-card .stat-label {
          font-size: 13px;
          color: var(--gray);
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .stat-card .stat-value {
          font-size: 28px;
          font-weight: 700;
          color: var(--secondary);
          margin-top: 5px;
        }

        .stat-card .stat-sub {
          font-size: 12px;
          color: var(--gray);
          margin-top: 5px;
        }

        .tabs-container {
          display: flex;
          gap: 5px;
          margin-bottom: 25px;
          background: white;
          padding: 5px;
          border-radius: 12px;
          box-shadow: var(--shadow);
          overflow-x: auto;
          flex-wrap: wrap;
        }

        .tab-btn {
          padding: 10px 20px;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 600;
          font-size: 14px;
          transition: all 0.3s;
          background: transparent;
          color: var(--gray);
          white-space: nowrap;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .tab-btn:hover {
          background: var(--light);
          color: var(--secondary);
        }

        .tab-btn.active {
          background: var(--primary);
          color: white;
        }

        .tab-btn i {
          font-size: 16px;
        }

        .section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          flex-wrap: wrap;
          gap: 10px;
        }

        .section-header h2 {
          font-size: 18px;
          font-weight: 700;
          color: var(--secondary);
        }

        .filters-section {
          background: white;
          border-radius: 12px;
          padding: 15px;
          box-shadow: var(--shadow);
          margin-bottom: 20px;
          display: flex;
          flex-wrap: wrap;
          gap: 15px;
          align-items: center;
        }

        .search-input {
          flex: 1;
          min-width: 200px;
          padding: 10px 15px;
          border: 2px solid var(--border);
          border-radius: 8px;
          font-size: 14px;
          transition: all 0.3s;
          background: white;
          color: var(--secondary);
        }

        .search-input:focus {
          outline: none;
          border-color: var(--primary);
        }

        .filter-select {
          padding: 10px 15px;
          border: 2px solid var(--border);
          border-radius: 8px;
          font-size: 14px;
          background: white;
          cursor: pointer;
          min-width: 150px;
          color: var(--secondary);
        }

        .filter-select:focus {
          outline: none;
          border-color: var(--primary);
        }

        .btn {
          padding: 10px 20px;
          border: none;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
        }

        .btn-primary {
          background: var(--primary);
          color: white;
        }

        .btn-primary:hover {
          background: var(--primary-dark);
          transform: translateY(-2px);
          box-shadow: var(--shadow-lg);
        }

        .btn-success {
          background: var(--success);
          color: white;
        }

        .btn-success:hover {
          opacity: 0.9;
          transform: translateY(-2px);
        }

        .btn-danger {
          background: var(--danger);
          color: white;
        }

        .btn-danger:hover {
          opacity: 0.9;
          transform: translateY(-2px);
        }

        .btn-outline {
          background: transparent;
          border: 2px solid var(--border);
          color: var(--secondary);
        }

        .btn-outline:hover {
          border-color: var(--primary);
          color: var(--primary);
        }

        .btn-sm {
          padding: 6px 12px;
          font-size: 12px;
        }

        .btn-info {
          background: var(--info);
          color: white;
        }

        .btn-info:hover {
          opacity: 0.9;
          transform: translateY(-2px);
        }

        /* Records Grid */
        .records-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 20px;
        }

        .record-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
          transition: all 0.3s;
        }

        .record-card:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-lg);
        }

        .record-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 10px;
        }

        .record-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin: 0;
        }

        .student-class {
          font-size: 12px;
          color: var(--gray);
        }

        .record-status {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
        }

        .record-details {
          font-size: 13px;
          color: var(--gray);
          margin-bottom: 15px;
        }

        .record-details p {
          margin: 5px 0;
        }

        .record-details i {
          width: 18px;
          color: var(--primary);
        }

        .record-actions {
          display: flex;
          gap: 8px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
          flex-wrap: wrap;
        }

        /* Prescriptions */
        .prescriptions-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 20px;
        }

        .prescription-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
        }

        .prescription-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }

        .prescription-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin: 0;
        }

        .prescription-type {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          background: #d1ecf1;
          color: #0c5460;
        }

        .prescription-details {
          font-size: 13px;
          color: var(--gray);
        }

        .prescription-details p {
          margin: 5px 0;
        }

        /* Allergies */
        .allergies-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 20px;
        }

        .allergy-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
        }

        .allergy-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }

        .allergy-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin: 0;
        }

        .allergy-severity {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          color: white;
        }

        .allergy-details {
          font-size: 13px;
          color: var(--gray);
        }

        .allergy-details p {
          margin: 5px 0;
        }

        /* Immunizations */
        .immunizations-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 20px;
        }

        .immunization-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
        }

        .immunization-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }

        .immunization-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin: 0;
        }

        .immunization-vaccine {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          background: #e8f5e9;
          color: #2e7d32;
        }

        .immunization-details {
          font-size: 13px;
          color: var(--gray);
        }

        .immunization-details p {
          margin: 5px 0;
        }

        /* Staff */
        .staff-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 20px;
        }

        .staff-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
        }

        .staff-header {
          display: flex;
          align-items: center;
          gap: 15px;
          margin-bottom: 10px;
        }

        .staff-avatar {
          width: 50px;
          height: 50px;
          border-radius: 50%;
          background: #4f46e5;
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 20px;
          font-weight: 600;
          flex-shrink: 0;
        }

        .staff-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin: 0;
        }

        .staff-header p {
          font-size: 12px;
          color: var(--gray);
          margin: 0;
        }

        .staff-status {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          margin-left: auto;
        }

        .staff-status.active {
          background: #d4edda;
          color: #155724;
        }

        .staff-status.inactive {
          background: #f8d7da;
          color: #721c24;
        }

        .staff-status.on_leave {
          background: #fff3cd;
          color: #856404;
        }

        .staff-details {
          font-size: 13px;
          color: var(--gray);
          margin-bottom: 15px;
        }

        .staff-details p {
          margin: 5px 0;
        }

        .staff-details i {
          width: 18px;
          color: var(--primary);
        }

        .staff-actions {
          display: flex;
          gap: 8px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
        }

        /* My Records */
        .my-records-section {
          padding: 10px 0;
        }

        .my-records-section h2 {
          font-size: 22px;
          font-weight: 700;
          color: var(--secondary);
          margin-bottom: 20px;
        }

        .student-health-summary {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 20px;
          margin-bottom: 30px;
        }

        .health-summary-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
        }

        .health-summary-card h4 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin-bottom: 15px;
        }

        .health-summary-card .no-data {
          color: var(--gray);
          font-style: italic;
        }

        .allergy-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 0;
          border-bottom: 1px solid var(--border);
        }

        .allergy-item:last-child {
          border-bottom: none;
        }

        .allergy-severity-badge {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          color: white;
        }

        .visit-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 0;
          border-bottom: 1px solid var(--border);
          font-size: 13px;
        }

        .visit-item:last-child {
          border-bottom: none;
        }

        .visit-date {
          color: var(--gray);
        }

        .visit-diagnosis {
          flex: 1;
          margin: 0 10px;
          color: var(--secondary);
        }

        .visit-status {
          padding: 2px 10px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
        }

        .visit-status.pending {
          background: #fff3cd;
          color: #856404;
        }

        .visit-status.in_progress {
          background: #d1ecf1;
          color: #0c5460;
        }

        .visit-status.completed {
          background: #d4edda;
          color: #155724;
        }

        .visit-status.referred {
          background: #fff3cd;
          color: #856404;
        }

        .immunization-item {
          display: flex;
          justify-content: space-between;
          padding: 8px 0;
          border-bottom: 1px solid var(--border);
          font-size: 13px;
        }

        .immunization-item:last-child {
          border-bottom: none;
        }

        .vaccine {
          font-weight: 500;
          color: var(--secondary);
        }

        .immunization-date {
          color: var(--gray);
        }

        .full-records {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
        }

        .full-records h3 {
          font-size: 18px;
          font-weight: 600;
          color: var(--secondary);
          margin-bottom: 15px;
        }

        .record-item {
          padding: 15px;
          border-bottom: 1px solid var(--border);
        }

        .record-item:last-child {
          border-bottom: none;
        }

        .record-item-header {
          display: flex;
          gap: 15px;
          align-items: center;
          margin-bottom: 8px;
          flex-wrap: wrap;
        }

        .record-date {
          font-weight: 500;
          color: var(--secondary);
        }

        .record-type {
          padding: 2px 10px;
          border-radius: 12px;
          font-size: 11px;
          background: var(--light);
          color: var(--gray);
        }

        .record-item-details {
          font-size: 13px;
          color: var(--gray);
        }

        .record-item-details p {
          margin: 4px 0;
        }

        /* Diagnosis Section */
        .diagnosis-section {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
          margin-bottom: 30px;
        }

        .diagnosis-section h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin-bottom: 15px;
        }

        .diagnosis-list {
          display: flex;
          flex-wrap: wrap;
          gap: 15px;
        }

        .diagnosis-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 16px;
          background: var(--light);
          border-radius: 8px;
        }

        .diagnosis-name {
          font-weight: 500;
          color: var(--secondary);
        }

        .diagnosis-count {
          padding: 2px 10px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          background: var(--primary);
          color: white;
        }

        /* Empty State */
        .empty-state {
          text-align: center;
          padding: 40px 20px;
          color: var(--gray);
        }

        .empty-state i {
          font-size: 48px;
          color: var(--border);
          margin-bottom: 15px;
        }

        /* Modals */
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 1000;
          display: none;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }

        .modal-overlay.active {
          display: flex;
        }

        .modal {
          background: white;
          border-radius: 16px;
          max-width: 700px;
          width: 100%;
          max-height: 90vh;
          overflow-y: auto;
          padding: 30px;
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 25px;
        }

        .modal-header h2 {
          font-size: 22px;
          color: var(--secondary);
        }

        .modal-close {
          width: 40px;
          height: 40px;
          border: none;
          border-radius: 50%;
          background: var(--light);
          cursor: pointer;
          font-size: 18px;
          transition: all 0.3s;
        }

        .modal-close:hover {
          background: var(--border);
        }

        .form-group {
          margin-bottom: 20px;
        }

        .form-group label {
          display: block;
          font-size: 14px;
          font-weight: 600;
          color: var(--secondary);
          margin-bottom: 5px;
        }

        .form-group label .required {
          color: var(--danger);
        }

        .form-group input,
        .form-group select,
        .form-group textarea {
          width: 100%;
          padding: 10px 15px;
          border: 2px solid var(--border);
          border-radius: 8px;
          font-size: 14px;
          transition: all 0.3s;
          background: white;
          color: var(--secondary);
        }

        .form-group input:focus,
        .form-group select:focus,
        .form-group textarea:focus {
          outline: none;
          border-color: var(--primary);
        }

        .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 15px;
        }

        .form-row .form-group {
          margin-bottom: 0;
        }

        .modal-footer {
          display: flex;
          gap: 10px;
          justify-content: flex-end;
          margin-top: 25px;
          padding-top: 20px;
          border-top: 1px solid var(--border);
        }

        /* Recent Activity */
        .recent-activity {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
        }

        .recent-activity h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin-bottom: 15px;
        }

        .activity-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .activity-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 0;
          border-bottom: 1px solid var(--border);
        }

        .activity-item:last-child {
          border-bottom: none;
        }

        .activity-icon {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: var(--light);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--primary);
          flex-shrink: 0;
        }

        .activity-content {
          flex: 1;
        }

        .activity-content .text {
          font-size: 14px;
          color: var(--secondary);
        }

        .activity-content .time {
          font-size: 12px;
          color: var(--gray);
        }

        /* Responsive */
        @media (max-width: 768px) {
          .stats-grid {
            grid-template-columns: repeat(2, 1fr);
          }

          .records-grid,
          .prescriptions-grid,
          .allergies-grid,
          .immunizations-grid,
          .staff-grid {
            grid-template-columns: 1fr;
          }

          .student-health-summary {
            grid-template-columns: 1fr;
          }

          .tabs-container {
            flex-wrap: nowrap;
            overflow-x: auto;
          }

          .tab-btn {
            padding: 8px 14px;
            font-size: 12px;
          }

          .form-row {
            grid-template-columns: 1fr;
          }

          .filters-section {
            flex-direction: column;
            align-items: stretch;
          }

          .search-input,
          .filter-select {
            width: 100%;
          }

          .section-header {
            flex-direction: column;
            align-items: stretch;
          }

          .modal {
            padding: 20px;
          }

          .record-header {
            flex-direction: column;
            gap: 8px;
          }

          .record-actions {
            flex-direction: column;
          }

          .record-actions .btn {
            width: 100%;
            justify-content: center;
          }
        }

        @media (max-width: 480px) {
          .stats-grid {
            grid-template-columns: 1fr;
          }

          .staff-header {
            flex-direction: column;
            align-items: center;
            text-align: center;
          }

          .visit-item {
            flex-direction: column;
            align-items: flex-start;
            gap: 5px;
          }

          .record-item-header {
            flex-direction: column;
            align-items: flex-start;
            gap: 5px;
          }
        }

        @keyframes slideOut {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(100%); opacity: 0; }
        }

        .custom-notification {
          position: fixed;
          top: 20px;
          right: 20px;
          padding: 15px 20px;
          border-radius: 8px;
          box-shadow: 0 5px 15px rgba(0,0,0,0.2);
          z-index: 10000;
          display: flex;
          align-items: center;
          gap: 10px;
          animation: slideIn 0.3s ease;
          max-width: 400px;
          word-wrap: break-word;
          color: white;
          font-family: 'Poppins', sans-serif;
        }
      `}</style>

      <div className="health-container">
        {/* Tabs */}
        <div className="tabs-container">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <i className={`fas ${tab.icon}`}></i>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content based on active tab */}
        {activeTab === 'dashboard' && renderDashboard()}
        {activeTab === 'records' && renderRecords()}
        {activeTab === 'visits' && renderRecords()}
        {activeTab === 'prescriptions' && renderPrescriptions()}
        {activeTab === 'allergies' && renderAllergies()}
        {activeTab === 'immunizations' && renderImmunizations()}
        {activeTab === 'staff' && renderStaff()}
        {activeTab === 'my-records' && renderMyRecords()}
        {activeTab === 'child-records' && renderMyRecords()}
      </div>

      {/* Modal Overlay */}
      {showModal && (
        <div className="modal-overlay active" onClick={(e) => {
          if (e.target === e.currentTarget) setShowModal(false);
        }}>
          {renderModal()}
        </div>
      )}
    </Layout>
  );
}
