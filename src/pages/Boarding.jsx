// src/pages/Boarding.jsx
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
const GENDER_TYPES = ['Boys', 'Girls', 'Mixed'];
const DORM_STATUS = {
  active: 'Active',
  inactive: 'Inactive',
  maintenance: 'Under Maintenance',
  full: 'Full',
  renovating: 'Renovating'
};

const DORM_STATUS_COLORS = {
  active: '#27ae60',
  inactive: '#95a5a6',
  maintenance: '#e74c3c',
  full: '#f39c12',
  renovating: '#e67e22'
};

const STUDENT_STATUS = {
  resident: 'Resident',
  temporary_leave: 'Temporary Leave',
  transferred: 'Transferred',
  graduated: 'Graduated'
};

const MAINTENANCE_PRIORITY = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent'
};

const MAINTENANCE_PRIORITY_COLORS = {
  low: '#27ae60',
  medium: '#f39c12',
  high: '#e67e22',
  urgent: '#e74c3c'
};

const MAINTENANCE_STATUS = {
  reported: 'Reported',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled'
};

export default function Boarding() {
  const navigate = useNavigate();
  const { currentUser, userData, userRole } = useAuth();
  const { isOnline, pendingCount, saveToIndexedDB, getFromIndexedDB, addToSyncQueue } = useSync();

  // State
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedDorm, setSelectedDorm] = useState(null);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [modalType, setModalType] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteItem, setDeleteItem] = useState(null);
  const [deleteType, setDeleteType] = useState('');
  const [selectedAssignment, setSelectedAssignment] = useState(null);
  const [selectedMaintenance, setSelectedMaintenance] = useState(null);
  const [selectedPatron, setSelectedPatron] = useState(null);
  const [selectedInventory, setSelectedInventory] = useState(null);
  const [selectedStaff, setSelectedStaff] = useState(null);
  
  // Data states
  const [dormitories, setDormitories] = useState([]);
  const [dormAssignments, setDormAssignments] = useState([]);
  const [dormPatrons, setDormPatrons] = useState([]);
  const [dormMaintenance, setDormMaintenance] = useState([]);
  const [dormRules, setDormRules] = useState([]);
  const [dormInventory, setDormInventory] = useState([]);
  const [students, setStudents] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [notifications, setNotifications] = useState([]);
  
  // Filter states
  const [filterDorm, setFilterDorm] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterGender, setFilterGender] = useState('');
  const [filterStudent, setFilterStudent] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDormForAssignment, setSelectedDormForAssignment] = useState('');
  
  // Form states
  const [dormForm, setDormForm] = useState({
    name: '',
    code: '',
    gender: 'Boys',
    capacity: '',
    currentOccupancy: 0,
    status: 'active',
    floor: '',
    block: '',
    description: '',
    notes: ''
  });

  const [assignmentForm, setAssignmentForm] = useState({
    studentId: '',
    dormId: '',
    bedNumber: '',
    roomNumber: '',
    status: 'resident',
    assignedDate: new Date().toISOString().split('T')[0],
    expectedEndDate: '',
    notes: ''
  });

  const [patronForm, setPatronForm] = useState({
    teacherId: '',
    dormId: '',
    role: 'patron',
    startDate: new Date().toISOString().split('T')[0],
    endDate: '',
    notes: ''
  });

  const [maintenanceForm, setMaintenanceForm] = useState({
    dormId: '',
    type: 'repair',
    description: '',
    priority: 'medium',
    status: 'reported',
    reportedBy: '',
    reportedDate: new Date().toISOString().split('T')[0],
    completedDate: '',
    cost: '',
    notes: ''
  });

  const [ruleForm, setRuleForm] = useState({
    dormId: '',
    title: '',
    description: '',
    priority: 'standard',
    category: 'general'
  });

  const [inventoryForm, setInventoryForm] = useState({
    dormId: '',
    itemName: '',
    quantity: '',
    description: '',
    condition: 'good',
    lastChecked: new Date().toISOString().split('T')[0],
    notes: ''
  });

  // Stats
  const [stats, setStats] = useState({
    totalDorms: 0,
    totalStudents: 0,
    totalCapacity: 0,
    occupancyRate: 0,
    activeDorms: 0,
    fullDorms: 0,
    totalPatrons: 0,
    pendingMaintenance: 0,
    totalBeds: 0,
    availableBeds: 0
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
  const isTeacher = userRole === 'teacher';
  const isStudent = userRole === 'student';
  const isParent = userRole === 'parent';

  const loadData = async () => {
    setLoading(true);
    try {
      const schoolId = userData?.schoolId || 'default_school';
      
      // Load all data in parallel
      const [
        dormsData,
        assignmentsData,
        patronsData,
        maintenanceData,
        rulesData,
        inventoryData,
        studentsData,
        teachersData
      ] = await Promise.all([
        loadCollection('dormitories', schoolId),
        loadCollection('dorm_assignments', schoolId),
        loadCollection('dorm_patrons', schoolId),
        loadCollection('dorm_maintenance', schoolId),
        loadCollection('dorm_rules', schoolId),
        loadCollection('dorm_inventory', schoolId),
        loadCollection('students', schoolId),
        loadCollection('teachers', schoolId)
      ]);

      setDormitories(dormsData);
      setDormAssignments(assignmentsData);
      setDormPatrons(patronsData);
      setDormMaintenance(maintenanceData);
      setDormRules(rulesData);
      setDormInventory(inventoryData);
      setStudents(studentsData);
      setTeachers(teachersData);

      calculateStats(dormsData, assignmentsData, patronsData, maintenanceData);
      setLoading(false);

      // Set up realtime listeners if online
      if (isOnline) {
        setupRealtimeListeners(schoolId);
      }

    } catch (error) {
      console.error('Error loading boarding data:', error);
      showNotification('Failed to load data', 'error');
      setLoading(false);
    }
  };

  const loadCollection = async (collectionName, schoolId) => {
    try {
      const cached = await getFromIndexedDB(`boarding_${collectionName}`);
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
        await saveToIndexedDB(`boarding_${collectionName}`, data);
        return data;
      }

      return [];
    } catch (error) {
      console.error(`Error loading ${collectionName}:`, error);
      return [];
    }
  };

  const setupRealtimeListeners = (schoolId) => {
    const collections = ['dormitories', 'dorm_assignments', 'dorm_patrons', 'dorm_maintenance', 'dorm_rules', 'dorm_inventory'];
    
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
          case 'dormitories':
            setDormitories(data);
            break;
          case 'dorm_assignments':
            setDormAssignments(data);
            break;
          case 'dorm_patrons':
            setDormPatrons(data);
            break;
          case 'dorm_maintenance':
            setDormMaintenance(data);
            break;
          case 'dorm_rules':
            setDormRules(data);
            break;
          case 'dorm_inventory':
            setDormInventory(data);
            break;
        }
        
        await saveToIndexedDB(`boarding_${collectionName}`, data);
      }, (error) => {
        console.error(`Listener error for ${collectionName}:`, error);
      });
      
      if (!unsubscribeRef.current) {
        unsubscribeRef.current = unsubscribe;
      }
    });
  };

  const calculateStats = (dormsData, assignmentsData, patronsData, maintenanceData) => {
    const totalDorms = dormsData.length;
    const totalCapacity = dormsData.reduce((sum, d) => sum + (d.capacity || 0), 0);
    const activeDorms = dormsData.filter(d => d.status === 'active').length;
    const fullDorms = dormsData.filter(d => d.status === 'full').length;
    
    // Calculate occupancy
    const totalAssigned = assignmentsData.filter(a => a.status === 'resident').length;
    const occupancyRate = totalCapacity > 0 ? (totalAssigned / totalCapacity) * 100 : 0;
    
    const availableBeds = totalCapacity - totalAssigned;
    const totalBeds = totalCapacity;
    
    const pendingMaintenance = maintenanceData.filter(m => m.status === 'reported' || m.status === 'in_progress').length;
    
    setStats({
      totalDorms,
      totalStudents: totalAssigned,
      totalCapacity,
      occupancyRate,
      activeDorms,
      fullDorms,
      totalPatrons: patronsData.length,
      pendingMaintenance,
      totalBeds,
      availableBeds
    });
  };

  // Get tabs based on role
  const getAvailableTabs = () => {
    const tabs = [];
    
    tabs.push({ id: 'dashboard', label: 'Dashboard', icon: 'fa-chart-pie' });
    
    if (isAdmin || isTeacher) {
      tabs.push({ id: 'dormitories', label: 'Dormitories', icon: 'fa-building' });
      tabs.push({ id: 'assignments', label: 'Assignments', icon: 'fa-user-check' });
      tabs.push({ id: 'patrons', label: 'Patrons', icon: 'fa-user-tie' });
      tabs.push({ id: 'maintenance', label: 'Maintenance', icon: 'fa-tools' });
      tabs.push({ id: 'rules', label: 'Rules', icon: 'fa-list-check' });
      tabs.push({ id: 'inventory', label: 'Inventory', icon: 'fa-boxes' });
    }
    
    if (isStudent) {
      tabs.push({ id: 'my-dorm', label: 'My Dorm', icon: 'fa-home' });
    }
    
    if (isParent) {
      tabs.push({ id: 'student-dorm', label: 'Student Dorm', icon: 'fa-child' });
    }
    
    return tabs;
  };

  const tabs = getAvailableTabs();

  // Notification helper
  const showNotification = (message, type = 'info') => {
        showAppNotice(message, type);
    };

  // Dormitory CRUD
  const handleAddDorm = async () => {
    try {
      const data = {
        ...dormForm,
        capacity: parseInt(dormForm.capacity),
        currentOccupancy: 0,
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'dormitories'), data);
      } else {
        await addToSyncQueue('dormitories', 'add', data);
        const updatedDorms = [data, ...dormitories];
        setDormitories(updatedDorms);
        await saveToIndexedDB('boarding_dormitories', updatedDorms);
      }

      showNotification('Dormitory added successfully!', 'success');
      setShowModal(false);
      resetDormForm();
    } catch (error) {
      console.error('Error adding dormitory:', error);
      showNotification('Failed to add dormitory', 'error');
    }
  };

  const handleUpdateDorm = async () => {
    try {
      const data = {
        ...dormForm,
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await updateDoc(doc(db, 'dormitories', selectedDorm.id), data);
      } else {
        await addToSyncQueue('dormitories', 'update', { id: selectedDorm.id, ...data });
      }

      const updatedDorms = dormitories.map(d => 
        d.id === selectedDorm.id ? { ...d, ...data } : d
      );
      setDormitories(updatedDorms);
      await saveToIndexedDB('boarding_dormitories', updatedDorms);

      showNotification('Dormitory updated successfully!', 'success');
      setShowModal(false);
      setSelectedDorm(null);
      resetDormForm();
    } catch (error) {
      console.error('Error updating dormitory:', error);
      showNotification('Failed to update dormitory', 'error');
    }
  };

  const handleDeleteDorm = async () => {
    try {
      // Check if there are students assigned
      const hasAssignments = dormAssignments.some(a => a.dormId === deleteItem.id);
      if (hasAssignments) {
        showNotification('Cannot delete dormitory with assigned students. Reassign students first.', 'error');
        setShowDeleteModal(false);
        return;
      }

      if (isOnline) {
        await deleteDoc(doc(db, 'dormitories', deleteItem.id));
      } else {
        await addToSyncQueue('dormitories', 'delete', { id: deleteItem.id });
      }

      const updatedDorms = dormitories.filter(d => d.id !== deleteItem.id);
      setDormitories(updatedDorms);
      await saveToIndexedDB('boarding_dormitories', updatedDorms);

      showNotification('Dormitory deleted successfully!', 'success');
      setShowDeleteModal(false);
      setDeleteItem(null);
    } catch (error) {
      console.error('Error deleting dormitory:', error);
      showNotification('Failed to delete dormitory', 'error');
    }
  };

  // Assignment CRUD
  const handleAddAssignment = async () => {
    try {
      // Check if dorm has capacity
      const dorm = dormitories.find(d => d.id === assignmentForm.dormId);
      const currentAssigned = dormAssignments.filter(a => a.dormId === assignmentForm.dormId && a.status === 'resident').length;
      
      if (dorm && currentAssigned >= dorm.capacity) {
        showNotification('This dormitory is at full capacity!', 'error');
        return;
      }

      const student = students.find(s => s.id === assignmentForm.studentId);
      if (!student) {
        showNotification('Student not found!', 'error');
        return;
      }

      const data = {
        ...assignmentForm,
        studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim(),
        studentClass: student.class || 'N/A',
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'dorm_assignments'), data);
        
        // Update dorm occupancy
        await updateDoc(doc(db, 'dormitories', assignmentForm.dormId), {
          currentOccupancy: increment(1),
          status: currentAssigned + 1 >= dorm.capacity ? 'full' : 'active'
        });
      } else {
        await addToSyncQueue('dorm_assignments', 'add', data);
        const updatedAssignments = [data, ...dormAssignments];
        setDormAssignments(updatedAssignments);
        await saveToIndexedDB('boarding_dorm_assignments', updatedAssignments);
      }

      showNotification('Student assigned to dormitory successfully!', 'success');
      setShowModal(false);
      resetAssignmentForm();
    } catch (error) {
      console.error('Error adding assignment:', error);
      showNotification('Failed to assign student', 'error');
    }
  };

 

  // Patron CRUD
  const handleAddPatron = async () => {
    try {
      const teacher = teachers.find(t => t.id === patronForm.teacherId);
      const dorm = dormitories.find(d => d.id === patronForm.dormId);

      const data = {
        ...patronForm,
        teacherName: teacher ? `${teacher.firstName || ''} ${teacher.lastName || ''}`.trim() : 'Unknown',
        dormName: dorm ? dorm.name : 'Unknown',
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'dorm_patrons'), data);
      } else {
        await addToSyncQueue('dorm_patrons', 'add', data);
        const updatedPatrons = [data, ...dormPatrons];
        setDormPatrons(updatedPatrons);
        await saveToIndexedDB('boarding_dorm_patrons', updatedPatrons);
      }

      showNotification('Patron assigned successfully!', 'success');
      setShowModal(false);
      resetPatronForm();
    } catch (error) {
      console.error('Error adding patron:', error);
      showNotification('Failed to assign patron', 'error');
    }
  };
 
const handleUpdatePatron = async () => {
    try {
        const data = {
            ...patronForm,
            updatedAt: new Date().toISOString()
        };

        if (isOnline) {
            await updateDoc(doc(db, 'dorm_patrons', selectedPatron.id), data);
        } else {
            await addToSyncQueue('dorm_patrons', 'update', { id: selectedPatron.id, ...data });
        }

        const updatedPatrons = dormPatrons.map(p => 
            p.id === selectedPatron.id ? { ...p, ...data } : p
        );
        setDormPatrons(updatedPatrons);
        await saveToIndexedDB('boarding_dorm_patrons', updatedPatrons);

        showNotification('Patron updated successfully!', 'success');
        setShowModal(false);
        setSelectedPatron(null);
        resetPatronForm();
    } catch (error) {
        console.error('Error updating patron:', error);
        showNotification('Failed to update patron', 'error');
    }
};

const handleUpdateAssignment = async () => {
    try {
        const data = {
            ...assignmentForm,
            updatedAt: new Date().toISOString()
        };

        if (isOnline) {
            await updateDoc(doc(db, 'dorm_assignments', selectedAssignment.id), data);
        } else {
            await addToSyncQueue('dorm_assignments', 'update', { id: selectedAssignment.id, ...data });
        }

        const updatedAssignments = dormAssignments.map(a => 
            a.id === selectedAssignment.id ? { ...a, ...data } : a
        );
        setDormAssignments(updatedAssignments);
        await saveToIndexedDB('boarding_dorm_assignments', updatedAssignments);

        showNotification('Assignment updated successfully!', 'success');
        setShowModal(false);
        setSelectedAssignment(null);
        resetAssignmentForm();
    } catch (error) {
        console.error('Error updating assignment:', error);
        showNotification('Failed to update assignment', 'error');
    }
};


const handleUpdateInventory = async () => {
    try {
        const data = {
            ...inventoryForm,
            updatedAt: new Date().toISOString()
        };

        if (isOnline) {
            await updateDoc(doc(db, 'dorm_inventory', selectedInventory.id), data);
        } else {
            await addToSyncQueue('dorm_inventory', 'update', { id: selectedInventory.id, ...data });
        }

        const updatedInventory = dormInventory.map(i => 
            i.id === selectedInventory.id ? { ...i, ...data } : i
        );
        setDormInventory(updatedInventory);
        await saveToIndexedDB('boarding_dorm_inventory', updatedInventory);

        showNotification('Inventory updated successfully!', 'success');
        setShowModal(false);
        setSelectedInventory(null);
        resetInventoryForm();
    } catch (error) {
        console.error('Error updating inventory:', error);
        showNotification('Failed to update inventory', 'error');
    }
};

const handleDeleteAssignment = async () => {
    try {
        if (isOnline) {
            await deleteDoc(doc(db, 'dorm_assignments', deleteItem.id));
        } else {
            await addToSyncQueue('dorm_assignments', 'delete', { id: deleteItem.id });
        }

        const updatedAssignments = dormAssignments.filter(a => a.id !== deleteItem.id);
        setDormAssignments(updatedAssignments);
        await saveToIndexedDB('boarding_dorm_assignments', updatedAssignments);

        showNotification('Assignment removed successfully!', 'success');
        setShowDeleteModal(false);
        setDeleteItem(null);
    } catch (error) {
        console.error('Error deleting assignment:', error);
        showNotification('Failed to delete assignment', 'error');
    }
};

const handleDeletePatron = async () => {
    try {
        if (isOnline) {
            await deleteDoc(doc(db, 'dorm_patrons', deleteItem.id));
        } else {
            await addToSyncQueue('dorm_patrons', 'delete', { id: deleteItem.id });
        }

        const updatedPatrons = dormPatrons.filter(p => p.id !== deleteItem.id);
        setDormPatrons(updatedPatrons);
        await saveToIndexedDB('boarding_dorm_patrons', updatedPatrons);

        showNotification('Patron removed successfully!', 'success');
        setShowDeleteModal(false);
        setDeleteItem(null);
    } catch (error) {
        console.error('Error deleting patron:', error);
        showNotification('Failed to delete patron', 'error');
    }
};

const handleDeleteRule = async () => {
    try {
        if (isOnline) {
            await deleteDoc(doc(db, 'dorm_rules', deleteItem.id));
        } else {
            await addToSyncQueue('dorm_rules', 'delete', { id: deleteItem.id });
        }

        const updatedRules = dormRules.filter(r => r.id !== deleteItem.id);
        setDormRules(updatedRules);
        await saveToIndexedDB('boarding_dorm_rules', updatedRules);

        showNotification('Rule deleted successfully!', 'success');
        setShowDeleteModal(false);
        setDeleteItem(null);
    } catch (error) {
        console.error('Error deleting rule:', error);
        showNotification('Failed to delete rule', 'error');
    }
};

const handleDeleteInventory = async () => {
    try {
        if (isOnline) {
            await deleteDoc(doc(db, 'dorm_inventory', deleteItem.id));
        } else {
            await addToSyncQueue('dorm_inventory', 'delete', { id: deleteItem.id });
        }

        const updatedInventory = dormInventory.filter(i => i.id !== deleteItem.id);
        setDormInventory(updatedInventory);
        await saveToIndexedDB('boarding_dorm_inventory', updatedInventory);

        showNotification('Inventory item deleted successfully!', 'success');
        setShowDeleteModal(false);
        setDeleteItem(null);
    } catch (error) {
        console.error('Error deleting inventory:', error);
        showNotification('Failed to delete inventory item', 'error');
    }
};

  // Maintenance CRUD
  const handleAddMaintenance = async () => {
    try {
      const data = {
        ...maintenanceForm,
        cost: parseFloat(maintenanceForm.cost) || 0,
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'dorm_maintenance'), data);
      } else {
        await addToSyncQueue('dorm_maintenance', 'add', data);
        const updatedRecords = [data, ...dormMaintenance];
        setDormMaintenance(updatedRecords);
        await saveToIndexedDB('boarding_dorm_maintenance', updatedRecords);
      }

      showNotification('Maintenance record added successfully!', 'success');
      setShowModal(false);
      resetMaintenanceForm();
    } catch (error) {
      console.error('Error adding maintenance record:', error);
      showNotification('Failed to add maintenance record', 'error');
    }
  };

  const handleUpdateMaintenance = async () => {
    try {
      const data = {
        ...maintenanceForm,
        cost: parseFloat(maintenanceForm.cost) || 0,
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await updateDoc(doc(db, 'dorm_maintenance', selectedMaintenance.id), data);
      } else {
        await addToSyncQueue('dorm_maintenance', 'update', { id: selectedMaintenance.id, ...data });
      }

      const updatedRecords = dormMaintenance.map(m => 
        m.id === selectedMaintenance.id ? { ...m, ...data } : m
      );
      setDormMaintenance(updatedRecords);
      await saveToIndexedDB('boarding_dorm_maintenance', updatedRecords);

      showNotification('Maintenance record updated successfully!', 'success');
      setShowModal(false);
      setSelectedMaintenance(null);
      resetMaintenanceForm();
    } catch (error) {
      console.error('Error updating maintenance record:', error);
      showNotification('Failed to update maintenance record', 'error');
    }
  };

  // Rules CRUD
  const handleAddRule = async () => {
    try {
      const data = {
        ...ruleForm,
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'dorm_rules'), data);
      } else {
        await addToSyncQueue('dorm_rules', 'add', data);
        const updatedRules = [data, ...dormRules];
        setDormRules(updatedRules);
        await saveToIndexedDB('boarding_dorm_rules', updatedRules);
      }

      showNotification('Rule added successfully!', 'success');
      setShowModal(false);
      resetRuleForm();
    } catch (error) {
      console.error('Error adding rule:', error);
      showNotification('Failed to add rule', 'error');
    }
  };

  // Inventory CRUD
  const handleAddInventory = async () => {
    try {
      const data = {
        ...inventoryForm,
        quantity: parseInt(inventoryForm.quantity) || 0,
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'dorm_inventory'), data);
      } else {
        await addToSyncQueue('dorm_inventory', 'add', data);
        const updatedInventory = [data, ...dormInventory];
        setDormInventory(updatedInventory);
        await saveToIndexedDB('boarding_dorm_inventory', updatedInventory);
      }

      showNotification('Inventory item added successfully!', 'success');
      setShowModal(false);
      resetInventoryForm();
    } catch (error) {
      console.error('Error adding inventory item:', error);
      showNotification('Failed to add inventory item', 'error');
    }
  };

  // Form reset functions
  const resetDormForm = () => {
    setDormForm({
      name: '',
      code: '',
      gender: 'Boys',
      capacity: '',
      currentOccupancy: 0,
      status: 'active',
      floor: '',
      block: '',
      description: '',
      notes: ''
    });
  };

  const resetAssignmentForm = () => {
    setAssignmentForm({
      studentId: '',
      dormId: '',
      bedNumber: '',
      roomNumber: '',
      status: 'resident',
      assignedDate: new Date().toISOString().split('T')[0],
      expectedEndDate: '',
      notes: ''
    });
  };

  const resetPatronForm = () => {
    setPatronForm({
      teacherId: '',
      dormId: '',
      role: 'patron',
      startDate: new Date().toISOString().split('T')[0],
      endDate: '',
      notes: ''
    });
  };

  const resetMaintenanceForm = () => {
    setMaintenanceForm({
      dormId: '',
      type: 'repair',
      description: '',
      priority: 'medium',
      status: 'reported',
      reportedBy: '',
      reportedDate: new Date().toISOString().split('T')[0],
      completedDate: '',
      cost: '',
      notes: ''
    });
  };

  const resetRuleForm = () => {
    setRuleForm({
      dormId: '',
      title: '',
      description: '',
      priority: 'standard',
      category: 'general'
    });
  };

  const resetInventoryForm = () => {
    setInventoryForm({
      dormId: '',
      itemName: '',
      quantity: '',
      description: '',
      condition: 'good',
      lastChecked: new Date().toISOString().split('T')[0],
      notes: ''
    });
  };

  // Render Dashboard
  const renderDashboard = () => (
    <>
      <div className="stats-grid">
        <div className="stat-card" onClick={() => setActiveTab('dormitories')} style={{ cursor: 'pointer' }}>
          <div className="stat-label">Total Dormitories</div>
          <div className="stat-value">{stats.totalDorms}</div>
          <div className="stat-sub">{stats.activeDorms} Active</div>
        </div>
        <div className="stat-card" onClick={() => setActiveTab('assignments')} style={{ cursor: 'pointer' }}>
          <div className="stat-label">Resident Students</div>
          <div className="stat-value">{stats.totalStudents}</div>
          <div className="stat-sub">{stats.availableBeds} Beds Available</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Occupancy Rate</div>
          <div className="stat-value">{stats.occupancyRate.toFixed(1)}%</div>
          <div className="stat-sub">{stats.totalCapacity} Total Capacity</div>
        </div>
        <div className="stat-card" onClick={() => setActiveTab('patrons')} style={{ cursor: 'pointer' }}>
          <div className="stat-label">Dorm Patrons</div>
          <div className="stat-value">{stats.totalPatrons}</div>
        </div>
        <div className="stat-card" onClick={() => setActiveTab('maintenance')} style={{ cursor: 'pointer' }}>
          <div className="stat-label">Pending Maintenance</div>
          <div className="stat-value" style={{ color: '#e74c3c' }}>{stats.pendingMaintenance}</div>
          <div className="stat-sub">Requires attention</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Full Dormitories</div>
          <div className="stat-value" style={{ color: '#f39c12' }}>{stats.fullDorms}</div>
        </div>
      </div>

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

  // Render Dormitories
  const renderDormitories = () => (
    <div className="dorms-section">
      <div className="section-header">
        <h2>Dormitories</h2>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => {
            setModalType('dorm');
            resetDormForm();
            setShowModal(true);
          }}>
            <i className="fas fa-plus"></i> Add Dormitory
          </button>
        )}
      </div>

      <div className="filters-section">
        <input
          type="text"
          className="search-input"
          placeholder="Search dormitories..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <select
          className="filter-select"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">All Status</option>
          {Object.entries(DORM_STATUS).map(([key, value]) => (
            <option key={key} value={key}>{value}</option>
          ))}
        </select>
        <select
          className="filter-select"
          value={filterGender}
          onChange={(e) => setFilterGender(e.target.value)}
        >
          <option value="">All Gender</option>
          {GENDER_TYPES.map(g => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
      </div>

      <div className="dorms-grid">
        {dormitories
          .filter(d => {
            const matchSearch = d.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                              d.code.toLowerCase().includes(searchTerm.toLowerCase());
            const matchStatus = !filterStatus || d.status === filterStatus;
            const matchGender = !filterGender || d.gender === filterGender;
            return matchSearch && matchStatus && matchGender;
          })
          .map(dorm => {
            const assignedCount = dormAssignments.filter(a => a.dormId === dorm.id && a.status === 'resident').length;
            const occupancyPercentage = dorm.capacity > 0 ? (assignedCount / dorm.capacity) * 100 : 0;
            const patrons = dormPatrons.filter(p => p.dormId === dorm.id);
            
            return (
              <div key={dorm.id} className="dorm-card">
                <div className="dorm-header">
                  <div>
                    <h3>{dorm.name}</h3>
                    <p className="dorm-code">{dorm.code || 'N/A'}</p>
                  </div>
                  <span className="dorm-status" style={{
                    background: DORM_STATUS_COLORS[dorm.status] + '20',
                    color: DORM_STATUS_COLORS[dorm.status]
                  }}>
                    {DORM_STATUS[dorm.status] || dorm.status}
                  </span>
                </div>
                <div className="dorm-details">
                  <p><i className="fas fa-venus-mars"></i> {dorm.gender}</p>
                  <p><i className="fas fa-users"></i> {assignedCount} / {dorm.capacity} students</p>
                  <p><i className="fas fa-chart-bar"></i> {occupancyPercentage.toFixed(0)}% Occupied</p>
                  <p><i className="fas fa-layer-group"></i> Floor: {dorm.floor || 'N/A'} | Block: {dorm.block || 'N/A'}</p>
                  {patrons.length > 0 && (
                    <p><i className="fas fa-user-tie"></i> Patrons: {patrons.map(p => p.teacherName).join(', ')}</p>
                  )}
                  {dorm.description && (
                    <p><i className="fas fa-info-circle"></i> {dorm.description}</p>
                  )}
                </div>
                {isAdmin && (
                  <div className="dorm-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => {
                      setSelectedDorm(dorm);
                      setModalType('dorm');
                      setDormForm(dorm);
                      setShowModal(true);
                    }}>
                      <i className="fas fa-edit"></i> Edit
                    </button>
                    <button className="btn btn-success btn-sm" onClick={() => {
                      setSelectedDormForAssignment(dorm.id);
                      setModalType('assignment');
                      resetAssignmentForm();
                      setAssignmentForm(prev => ({ ...prev, dormId: dorm.id }));
                      setShowModal(true);
                    }}>
                      <i className="fas fa-user-plus"></i> Assign
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => {
                      setDeleteItem(dorm);
                      setDeleteType('dorm');
                      setShowDeleteModal(true);
                    }}>
                      <i className="fas fa-trash"></i>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        {dormitories.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-building"></i>
            <p>No dormitories registered yet</p>
          </div>
        )}
      </div>
    </div>
  );

  // Render Assignments
  const renderAssignments = () => (
    <div className="assignments-section">
      <div className="section-header">
        <h2>Dorm Assignments</h2>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => {
            setModalType('assignment');
            resetAssignmentForm();
            setShowModal(true);
          }}>
            <i className="fas fa-plus"></i> Assign Student
          </button>
        )}
      </div>

      <div className="filters-section">
        <input
          type="text"
          className="search-input"
          placeholder="Search student or dorm..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <select
          className="filter-select"
          value={filterDorm}
          onChange={(e) => setFilterDorm(e.target.value)}
        >
          <option value="">All Dormitories</option>
          {dormitories.map(d => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <select
          className="filter-select"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">All Status</option>
          {Object.entries(STUDENT_STATUS).map(([key, value]) => (
            <option key={key} value={key}>{value}</option>
          ))}
        </select>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Student</th>
              <th>Dormitory</th>
              <th>Room</th>
              <th>Bed</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {dormAssignments
              .filter(a => {
                const student = students.find(s => s.id === a.studentId);
                const dorm = dormitories.find(d => d.id === a.dormId);
                const matchSearch = (student?.firstName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                                  (student?.lastName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                                  (dorm?.name || '').toLowerCase().includes(searchTerm.toLowerCase());
                const matchDorm = !filterDorm || a.dormId === filterDorm;
                const matchStatus = !filterStatus || a.status === filterStatus;
                return matchSearch && matchDorm && matchStatus;
              })
              .map(assignment => {
                const student = students.find(s => s.id === assignment.studentId);
                const dorm = dormitories.find(d => d.id === assignment.dormId);
                return (
                  <tr key={assignment.id}>
                    <td>
                      <div className="student-info">
                        <strong>{student ? `${student.firstName} ${student.lastName}` : 'Unknown'}</strong>
                        <span className="student-class">{student?.class || 'N/A'}</span>
                      </div>
                    </td>
                    <td>{dorm?.name || 'N/A'}</td>
                    <td>{assignment.roomNumber || 'N/A'}</td>
                    <td>{assignment.bedNumber || 'N/A'}</td>
                    <td>
                      <span className={`status-badge ${assignment.status}`}>
                        {STUDENT_STATUS[assignment.status] || assignment.status}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-primary btn-sm" onClick={() => {
                        setSelectedAssignment(assignment);
                        setModalType('assignment');
                        setAssignmentForm(assignment);
                        setShowModal(true);
                      }}>
                        <i className="fas fa-edit"></i>
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => {
                        setDeleteItem(assignment);
                        setDeleteType('assignment');
                        setShowDeleteModal(true);
                      }}>
                        <i className="fas fa-trash"></i>
                      </button>
                    </td>
                  </tr>
                );
              })}
            {dormAssignments.length === 0 && (
              <tr>
                <td colSpan="6">
                  <div className="empty-state">
                    <i className="fas fa-user-check"></i>
                    <p>No dorm assignments yet</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  // Render Patrons
  const renderPatrons = () => (
    <div className="patrons-section">
      <div className="section-header">
        <h2>Dorm Patrons</h2>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => {
            setModalType('patron');
            resetPatronForm();
            setShowModal(true);
          }}>
            <i className="fas fa-plus"></i> Assign Patron
          </button>
        )}
      </div>

      <div className="patrons-grid">
        {dormPatrons.map(patron => {
          const teacher = teachers.find(t => t.id === patron.teacherId);
          const dorm = dormitories.find(d => d.id === patron.dormId);
          return (
            <div key={patron.id} className="patron-card">
              <div className="patron-header">
                <div className="patron-avatar">
                  {(patron.teacherName || 'T')[0].toUpperCase()}
                </div>
                <div>
                  <h3>{patron.teacherName}</h3>
                  <p>{teacher?.email || 'N/A'}</p>
                </div>
                <span className="patron-role">{patron.role}</span>
              </div>
              <div className="patron-details">
                <p><i className="fas fa-building"></i> Dorm: {patron.dormName}</p>
                <p><i className="fas fa-calendar-alt"></i> Started: {new Date(patron.startDate).toLocaleDateString()}</p>
                {patron.endDate && (
                  <p><i className="fas fa-calendar-times"></i> Ends: {new Date(patron.endDate).toLocaleDateString()}</p>
                )}
                {patron.notes && (
                  <p><i className="fas fa-sticky-note"></i> {patron.notes}</p>
                )}
              </div>
              {isAdmin && (
                <div className="patron-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => {
                    setSelectedPatron(patron);
                    setModalType('patron');
                    setPatronForm(patron);
                    setShowModal(true);
                  }}>
                    <i className="fas fa-edit"></i> Edit
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => {
                    setDeleteItem(patron);
                    setDeleteType('patron');
                    setShowDeleteModal(true);
                  }}>
                    <i className="fas fa-trash"></i>
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {dormPatrons.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-user-tie"></i>
            <p>No patrons assigned yet</p>
          </div>
        )}
      </div>
    </div>
  );

  // Render Maintenance
  const renderMaintenance = () => (
    <div className="maintenance-section">
      <div className="section-header">
        <h2>Dorm Maintenance</h2>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => {
            setModalType('maintenance');
            resetMaintenanceForm();
            setShowModal(true);
          }}>
            <i className="fas fa-plus"></i> Add Report
          </button>
        )}
      </div>

      <div className="filters-section">
        <select
          className="filter-select"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">All Status</option>
          {Object.entries(MAINTENANCE_STATUS).map(([key, value]) => (
            <option key={key} value={key}>{value}</option>
          ))}
        </select>
        <select
          className="filter-select"
          value={filterDorm}
          onChange={(e) => setFilterDorm(e.target.value)}
        >
          <option value="">All Dormitories</option>
          {dormitories.map(d => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>

      <div className="maintenance-grid">
        {dormMaintenance
          .filter(m => {
            const matchStatus = !filterStatus || m.status === filterStatus;
            const matchDorm = !filterDorm || m.dormId === filterDorm;
            return matchStatus && matchDorm;
          })
          .map(record => {
            const dorm = dormitories.find(d => d.id === record.dormId);
            return (
              <div key={record.id} className="maintenance-card">
                <div className="maintenance-header">
                  <h3>{dorm?.name || 'N/A'}</h3>
                  <span className="maintenance-priority" style={{
                    background: MAINTENANCE_PRIORITY_COLORS[record.priority] + '20',
                    color: MAINTENANCE_PRIORITY_COLORS[record.priority]
                  }}>
                    {MAINTENANCE_PRIORITY[record.priority]}
                  </span>
                </div>
                <div className="maintenance-details">
                  <p><strong>Type:</strong> {record.type}</p>
                  <p><strong>Description:</strong> {record.description}</p>
                  <p><strong>Status:</strong> {MAINTENANCE_STATUS[record.status]}</p>
                  <p><strong>Reported:</strong> {new Date(record.reportedDate).toLocaleDateString()}</p>
                  {record.completedDate && (
                    <p><strong>Completed:</strong> {new Date(record.completedDate).toLocaleDateString()}</p>
                  )}
                  {record.cost > 0 && (
                    <p><strong>Cost:</strong> KES {record.cost.toLocaleString()}</p>
                  )}
                  {record.notes && (
                    <p><strong>Notes:</strong> {record.notes}</p>
                  )}
                </div>
                {isAdmin && (
                  <div className="maintenance-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => {
                      setSelectedMaintenance(record);
                      setModalType('maintenance');
                      setMaintenanceForm(record);
                      setShowModal(true);
                    }}>
                      <i className="fas fa-edit"></i> Update
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        {dormMaintenance.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-tools"></i>
            <p>No maintenance records</p>
          </div>
        )}
      </div>
    </div>
  );

  // Render Rules
  const renderRules = () => (
    <div className="rules-section">
      <div className="section-header">
        <h2>Dorm Rules</h2>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => {
            setModalType('rule');
            resetRuleForm();
            setShowModal(true);
          }}>
            <i className="fas fa-plus"></i> Add Rule
          </button>
        )}
      </div>

      <div className="rules-list">
        {dormRules
          .filter(r => {
            const dorm = dormitories.find(d => d.id === r.dormId);
            const matchSearch = r.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                              dorm?.name.toLowerCase().includes(searchTerm.toLowerCase());
            return matchSearch;
          })
          .map(rule => {
            const dorm = dormitories.find(d => d.id === rule.dormId);
            return (
              <div key={rule.id} className="rule-card">
                <div className="rule-header">
                  <div>
                    <h4>{rule.title}</h4>
                    <span className="rule-dorm">{dorm?.name || 'All Dorms'}</span>
                  </div>
                  <span className="rule-category">{rule.category}</span>
                </div>
                <p className="rule-description">{rule.description}</p>
                <div className="rule-meta">
                  <span className="rule-priority">{rule.priority}</span>
                </div>
                {isAdmin && (
                  <div className="rule-actions">
                    <button className="btn btn-danger btn-sm" onClick={() => {
                      setDeleteItem(rule);
                      setDeleteType('rule');
                      setShowDeleteModal(true);
                    }}>
                      <i className="fas fa-trash"></i>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        {dormRules.length === 0 && (
          <div className="empty-state">
            <i className="fas fa-list-check"></i>
            <p>No rules added yet</p>
          </div>
        )}
      </div>
    </div>
  );

  // Render Inventory
  const renderInventory = () => (
    <div className="inventory-section">
      <div className="section-header">
        <h2>Dorm Inventory</h2>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => {
            setModalType('inventory');
            resetInventoryForm();
            setShowModal(true);
          }}>
            <i className="fas fa-plus"></i> Add Item
          </button>
        )}
      </div>

      <div className="inventory-grid">
        {dormInventory
          .filter(item => {
            const dorm = dormitories.find(d => d.id === item.dormId);
            const matchSearch = item.itemName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                              dorm?.name.toLowerCase().includes(searchTerm.toLowerCase());
            return matchSearch;
          })
          .map(item => {
            const dorm = dormitories.find(d => d.id === item.dormId);
            return (
              <div key={item.id} className="inventory-card">
                <div className="inventory-header">
                  <h3>{item.itemName}</h3>
                  <span className="inventory-condition">{item.condition}</span>
                </div>
                <div className="inventory-details">
                  <p><strong>Dorm:</strong> {dorm?.name || 'N/A'}</p>
                  <p><strong>Quantity:</strong> {item.quantity}</p>
                  <p><strong>Description:</strong> {item.description || 'N/A'}</p>
                  <p><strong>Last Checked:</strong> {new Date(item.lastChecked).toLocaleDateString()}</p>
                  {item.notes && (
                    <p><strong>Notes:</strong> {item.notes}</p>
                  )}
                </div>
                {isAdmin && (
                  <div className="inventory-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => {
                      setSelectedInventory(item);
                      setModalType('inventory');
                      setInventoryForm(item);
                      setShowModal(true);
                    }}>
                      <i className="fas fa-edit"></i> Edit
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => {
                      setDeleteItem(item);
                      setDeleteType('inventory');
                      setShowDeleteModal(true);
                    }}>
                      <i className="fas fa-trash"></i>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        {dormInventory.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-boxes"></i>
            <p>No inventory items</p>
          </div>
        )}
      </div>
    </div>
  );

  // Render My Dorm (Student view)
  const renderMyDorm = () => {
    const student = students.find(s => s.id === currentUser?.uid || s.email === currentUser?.email);
    const assignment = dormAssignments.find(a => a.studentId === student?.id && a.status === 'resident');
    
    if (!assignment) {
      return (
        <div className="my-dorm-section">
          <div className="empty-state">
            <i className="fas fa-home"></i>
            <h3>No Dormitory Assigned</h3>
            <p>You are not currently assigned to any dormitory.</p>
          </div>
        </div>
      );
    }

    const dorm = dormitories.find(d => d.id === assignment.dormId);
    const patrons = dormPatrons.filter(p => p.dormId === assignment.dormId);
    const rules = dormRules.filter(r => r.dormId === assignment.dormId);

    return (
      <div className="my-dorm-section">
        <h2>My Dormitory</h2>
        
        <div className="dorm-detail-card">
          <div className="dorm-detail-header">
            <h3>{dorm?.name || 'N/A'}</h3>
            <span className="dorm-gender">{dorm?.gender}</span>
          </div>
          <div className="dorm-detail-info">
            <p><i className="fas fa-bed"></i> Room: {assignment.roomNumber || 'N/A'} | Bed: {assignment.bedNumber || 'N/A'}</p>
            <p><i className="fas fa-building"></i> Block: {dorm?.block || 'N/A'} | Floor: {dorm?.floor || 'N/A'}</p>
            {dorm?.description && (
              <p><i className="fas fa-info-circle"></i> {dorm.description}</p>
            )}
          </div>
        </div>

        {patrons.length > 0 && (
          <div className="patrons-section">
            <h4>Dorm Patrons</h4>
            {patrons.map(patron => (
              <div key={patron.id} className="patron-info">
                <i className="fas fa-user-tie"></i>
                <span>{patron.teacherName} ({patron.role})</span>
              </div>
            ))}
          </div>
        )}

        {rules.length > 0 && (
          <div className="rules-section">
            <h4>Dorm Rules</h4>
            <ul className="rules-list">
              {rules.map(rule => (
                <li key={rule.id}>
                  <strong>{rule.title}</strong>
                  <p>{rule.description}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  };

  // Modal render function
  const renderModal = () => {
    switch(modalType) {
      case 'dorm':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>{selectedDorm ? 'Edit Dormitory' : 'Add Dormitory'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              selectedDorm ? handleUpdateDorm() : handleAddDorm();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Dorm Name <span className="required">*</span></label>
                  <input
                    type="text"
                    value={dormForm.name}
                    onChange={(e) => setDormForm({ ...dormForm, name: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Code <span className="required">*</span></label>
                  <input
                    type="text"
                    value={dormForm.code}
                    onChange={(e) => setDormForm({ ...dormForm, code: e.target.value })}
                    required
                    placeholder="e.g., D-001"
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Gender <span className="required">*</span></label>
                  <select
                    value={dormForm.gender}
                    onChange={(e) => setDormForm({ ...dormForm, gender: e.target.value })}
                    required
                  >
                    {GENDER_TYPES.map(g => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Capacity <span className="required">*</span></label>
                  <input
                    type="number"
                    value={dormForm.capacity}
                    onChange={(e) => setDormForm({ ...dormForm, capacity: e.target.value })}
                    required
                    min="1"
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Status</label>
                  <select
                    value={dormForm.status}
                    onChange={(e) => setDormForm({ ...dormForm, status: e.target.value })}
                  >
                    {Object.entries(DORM_STATUS).map(([key, value]) => (
                      <option key={key} value={key}>{value}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Floor</label>
                  <input
                    type="text"
                    value={dormForm.floor}
                    onChange={(e) => setDormForm({ ...dormForm, floor: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Block</label>
                  <input
                    type="text"
                    value={dormForm.block}
                    onChange={(e) => setDormForm({ ...dormForm, block: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={dormForm.description}
                  onChange={(e) => setDormForm({ ...dormForm, description: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={dormForm.notes}
                  onChange={(e) => setDormForm({ ...dormForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {selectedDorm ? 'Update' : 'Add'} Dormitory
                </button>
              </div>
            </form>
          </div>
        );

      case 'assignment':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>{selectedAssignment ? 'Edit Assignment' : 'Assign Student to Dorm'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              selectedAssignment ? handleUpdateAssignment() : handleAddAssignment();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Student <span className="required">*</span></label>
                  <select
                    value={assignmentForm.studentId}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, studentId: e.target.value })}
                    required
                  >
                    <option value="">Select Student</option>
                    {students
                      .filter(s => !dormAssignments.some(a => a.studentId === s.id && a.status === 'resident'))
                      .map(s => (
                        <option key={s.id} value={s.id}>
                          {s.firstName} {s.lastName} - {s.class}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Dormitory <span className="required">*</span></label>
                  <select
                    value={assignmentForm.dormId}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, dormId: e.target.value })}
                    required
                  >
                    <option value="">Select Dormitory</option>
                    {dormitories.map(d => {
                      const assigned = dormAssignments.filter(a => a.dormId === d.id && a.status === 'resident').length;
                      const available = d.capacity - assigned;
                      return (
                        <option key={d.id} value={d.id}>
                          {d.name} ({available} beds available)
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Room Number</label>
                  <input
                    type="text"
                    value={assignmentForm.roomNumber}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, roomNumber: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Bed Number</label>
                  <input
                    type="text"
                    value={assignmentForm.bedNumber}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, bedNumber: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Status</label>
                  <select
                    value={assignmentForm.status}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, status: e.target.value })}
                  >
                    {Object.entries(STUDENT_STATUS).map(([key, value]) => (
                      <option key={key} value={key}>{value}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Assigned Date</label>
                  <input
                    type="date"
                    value={assignmentForm.assignedDate}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, assignedDate: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Expected End Date</label>
                <input
                  type="date"
                  value={assignmentForm.expectedEndDate}
                  onChange={(e) => setAssignmentForm({ ...assignmentForm, expectedEndDate: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={assignmentForm.notes}
                  onChange={(e) => setAssignmentForm({ ...assignmentForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {selectedAssignment ? 'Update' : 'Assign'} Student
                </button>
              </div>
            </form>
          </div>
        );

      case 'patron':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>{selectedPatron ? 'Edit Patron' : 'Assign Patron'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              selectedPatron ? handleUpdatePatron() : handleAddPatron();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Teacher <span className="required">*</span></label>
                  <select
                    value={patronForm.teacherId}
                    onChange={(e) => setPatronForm({ ...patronForm, teacherId: e.target.value })}
                    required
                  >
                    <option value="">Select Teacher</option>
                    {teachers.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.firstName} {t.lastName}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Dormitory <span className="required">*</span></label>
                  <select
                    value={patronForm.dormId}
                    onChange={(e) => setPatronForm({ ...patronForm, dormId: e.target.value })}
                    required
                  >
                    <option value="">Select Dormitory</option>
                    {dormitories.map(d => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Role</label>
                  <select
                    value={patronForm.role}
                    onChange={(e) => setPatronForm({ ...patronForm, role: e.target.value })}
                  >
                    <option value="patron">Patron</option>
                    <option value="assistant_patron">Assistant Patron</option>
                    <option value="matron">Matron</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Start Date</label>
                  <input
                    type="date"
                    value={patronForm.startDate}
                    onChange={(e) => setPatronForm({ ...patronForm, startDate: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>End Date</label>
                <input
                  type="date"
                  value={patronForm.endDate}
                  onChange={(e) => setPatronForm({ ...patronForm, endDate: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={patronForm.notes}
                  onChange={(e) => setPatronForm({ ...patronForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {selectedPatron ? 'Update' : 'Assign'} Patron
                </button>
              </div>
            </form>
          </div>
        );

      case 'maintenance':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>{selectedMaintenance ? 'Update Maintenance' : 'Add Maintenance Report'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              selectedMaintenance ? handleUpdateMaintenance() : handleAddMaintenance();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Dormitory <span className="required">*</span></label>
                  <select
                    value={maintenanceForm.dormId}
                    onChange={(e) => setMaintenanceForm({ ...maintenanceForm, dormId: e.target.value })}
                    required
                  >
                    <option value="">Select Dormitory</option>
                    {dormitories.map(d => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Type <span className="required">*</span></label>
                  <select
                    value={maintenanceForm.type}
                    onChange={(e) => setMaintenanceForm({ ...maintenanceForm, type: e.target.value })}
                    required
                  >
                    <option value="repair">Repair</option>
                    <option value="cleaning">Cleaning</option>
                    <option value="painting">Painting</option>
                    <option value="plumbing">Plumbing</option>
                    <option value="electrical">Electrical</option>
                    <option value="furniture">Furniture</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Description <span className="required">*</span></label>
                <textarea
                  value={maintenanceForm.description}
                  onChange={(e) => setMaintenanceForm({ ...maintenanceForm, description: e.target.value })}
                  required
                  rows="2"
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Priority <span className="required">*</span></label>
                  <select
                    value={maintenanceForm.priority}
                    onChange={(e) => setMaintenanceForm({ ...maintenanceForm, priority: e.target.value })}
                    required
                  >
                    {Object.entries(MAINTENANCE_PRIORITY).map(([key, value]) => (
                      <option key={key} value={key}>{value}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Status</label>
                  <select
                    value={maintenanceForm.status}
                    onChange={(e) => setMaintenanceForm({ ...maintenanceForm, status: e.target.value })}
                  >
                    {Object.entries(MAINTENANCE_STATUS).map(([key, value]) => (
                      <option key={key} value={key}>{value}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Reported Date</label>
                  <input
                    type="date"
                    value={maintenanceForm.reportedDate}
                    onChange={(e) => setMaintenanceForm({ ...maintenanceForm, reportedDate: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Completed Date</label>
                  <input
                    type="date"
                    value={maintenanceForm.completedDate}
                    onChange={(e) => setMaintenanceForm({ ...maintenanceForm, completedDate: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Cost (KES)</label>
                  <input
                    type="number"
                    value={maintenanceForm.cost}
                    onChange={(e) => setMaintenanceForm({ ...maintenanceForm, cost: e.target.value })}
                    min="0"
                  />
                </div>
                <div className="form-group">
                  <label>Reported By</label>
                  <input
                    type="text"
                    value={maintenanceForm.reportedBy}
                    onChange={(e) => setMaintenanceForm({ ...maintenanceForm, reportedBy: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={maintenanceForm.notes}
                  onChange={(e) => setMaintenanceForm({ ...maintenanceForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {selectedMaintenance ? 'Update' : 'Add'} Record
                </button>
              </div>
            </form>
          </div>
        );

      case 'rule':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>Add Rule</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              handleAddRule();
            }}>
              <div className="form-group">
                <label>Dormitory <span className="required">*</span></label>
                <select
                  value={ruleForm.dormId}
                  onChange={(e) => setRuleForm({ ...ruleForm, dormId: e.target.value })}
                  required
                >
                  <option value="">All Dormitories</option>
                  {dormitories.map(d => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Rule Title <span className="required">*</span></label>
                <input
                  type="text"
                  value={ruleForm.title}
                  onChange={(e) => setRuleForm({ ...ruleForm, title: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>Description <span className="required">*</span></label>
                <textarea
                  value={ruleForm.description}
                  onChange={(e) => setRuleForm({ ...ruleForm, description: e.target.value })}
                  required
                  rows="3"
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Priority</label>
                  <select
                    value={ruleForm.priority}
                    onChange={(e) => setRuleForm({ ...ruleForm, priority: e.target.value })}
                  >
                    <option value="standard">Standard</option>
                    <option value="important">Important</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Category</label>
                  <select
                    value={ruleForm.category}
                    onChange={(e) => setRuleForm({ ...ruleForm, category: e.target.value })}
                  >
                    <option value="general">General</option>
                    <option value="safety">Safety</option>
                    <option value="conduct">Conduct</option>
                    <option value="hygiene">Hygiene</option>
                    <option value="study">Study</option>
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Add Rule
                </button>
              </div>
            </form>
          </div>
        );

      case 'inventory':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>{selectedInventory ? 'Edit Inventory Item' : 'Add Inventory Item'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              selectedInventory ? handleUpdateInventory() : handleAddInventory();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Dormitory <span className="required">*</span></label>
                  <select
                    value={inventoryForm.dormId}
                    onChange={(e) => setInventoryForm({ ...inventoryForm, dormId: e.target.value })}
                    required
                  >
                    <option value="">Select Dormitory</option>
                    {dormitories.map(d => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Item Name <span className="required">*</span></label>
                  <input
                    type="text"
                    value={inventoryForm.itemName}
                    onChange={(e) => setInventoryForm({ ...inventoryForm, itemName: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Quantity <span className="required">*</span></label>
                  <input
                    type="number"
                    value={inventoryForm.quantity}
                    onChange={(e) => setInventoryForm({ ...inventoryForm, quantity: e.target.value })}
                    required
                    min="0"
                  />
                </div>
                <div className="form-group">
                  <label>Condition</label>
                  <select
                    value={inventoryForm.condition}
                    onChange={(e) => setInventoryForm({ ...inventoryForm, condition: e.target.value })}
                  >
                    <option value="good">Good</option>
                    <option value="fair">Fair</option>
                    <option value="poor">Poor</option>
                    <option value="needs_repair">Needs Repair</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={inventoryForm.description}
                  onChange={(e) => setInventoryForm({ ...inventoryForm, description: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Last Checked</label>
                  <input
                    type="date"
                    value={inventoryForm.lastChecked}
                    onChange={(e) => setInventoryForm({ ...inventoryForm, lastChecked: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={inventoryForm.notes}
                  onChange={(e) => setInventoryForm({ ...inventoryForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {selectedInventory ? 'Update' : 'Add'} Item
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
    return <LoadingSpinner fullScreen text="Loading boarding data..." />;
  }

  return (
    <Layout title="Boarding Management">
      <style>{`
        .boarding-container {
          padding: 0;
        }

        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
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

        /* Dormitories Grid */
        .dorms-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 20px;
        }

        .dorm-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
          transition: all 0.3s;
        }

        .dorm-card:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-lg);
        }

        .dorm-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 10px;
        }

        .dorm-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin: 0;
        }

        .dorm-code {
          font-size: 12px;
          color: var(--gray);
        }

        .dorm-status {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
        }

        .dorm-details {
          font-size: 13px;
          color: var(--gray);
          margin-bottom: 15px;
        }

        .dorm-details p {
          margin: 5px 0;
        }

        .dorm-details i {
          width: 18px;
          color: var(--primary);
        }

        .dorm-actions {
          display: flex;
          gap: 8px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
        }

        /* Patrons Grid */
        .patrons-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 20px;
        }

        .patron-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
          transition: all 0.3s;
        }

        .patron-card:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-lg);
        }

        .patron-header {
          display: flex;
          align-items: center;
          gap: 15px;
          margin-bottom: 10px;
        }

        .patron-avatar {
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

        .patron-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin: 0;
        }

        .patron-header p {
          font-size: 12px;
          color: var(--gray);
          margin: 0;
        }

        .patron-role {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          background: #d4edda;
          color: #155724;
        }

        .patron-details {
          font-size: 13px;
          color: var(--gray);
          margin-bottom: 15px;
        }

        .patron-details p {
          margin: 5px 0;
        }

        .patron-details i {
          width: 18px;
          color: var(--primary);
        }

        .patron-actions {
          display: flex;
          gap: 8px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
        }

        /* Maintenance Grid */
        .maintenance-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 20px;
        }

        .maintenance-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
        }

        .maintenance-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }

        .maintenance-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin: 0;
        }

        .maintenance-priority {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
        }

        .maintenance-details {
          font-size: 13px;
          color: var(--gray);
          margin-bottom: 15px;
        }

        .maintenance-details p {
          margin: 5px 0;
        }

        .maintenance-actions {
          display: flex;
          gap: 8px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
        }

        /* Rules */
        .rules-list {
          display: flex;
          flex-direction: column;
          gap: 15px;
        }

        .rule-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
        }

        .rule-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }

        .rule-header h4 {
          font-size: 15px;
          font-weight: 600;
          color: var(--secondary);
          margin: 0;
        }

        .rule-dorm {
          font-size: 12px;
          color: var(--gray);
          margin-left: 10px;
        }

        .rule-category {
          padding: 2px 10px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          background: var(--light);
          color: var(--gray);
        }

        .rule-description {
          font-size: 13px;
          color: var(--gray);
          margin: 8px 0;
        }

        .rule-meta {
          display: flex;
          gap: 10px;
          margin-top: 10px;
        }

        .rule-priority {
          padding: 2px 10px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          background: #e8f5e9;
          color: #2e7d32;
        }

        .rule-actions {
          display: flex;
          gap: 8px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
        }

        /* Inventory */
        .inventory-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 20px;
        }

        .inventory-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
        }

        .inventory-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }

        .inventory-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin: 0;
        }

        .inventory-condition {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
        }

        .inventory-condition.good {
          background: #d4edda;
          color: #155724;
        }

        .inventory-condition.fair {
          background: #fff3cd;
          color: #856404;
        }

        .inventory-condition.poor {
          background: #f8d7da;
          color: #721c24;
        }

        .inventory-condition.needs_repair {
          background: #f8d7da;
          color: #721c24;
        }

        .inventory-details {
          font-size: 13px;
          color: var(--gray);
          margin-bottom: 15px;
        }

        .inventory-details p {
          margin: 5px 0;
        }

        .inventory-actions {
          display: flex;
          gap: 8px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
        }

        /* Student Info */
        .student-info {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .student-info strong {
          font-size: 14px;
          color: var(--secondary);
        }

        .student-class {
          padding: 2px 10px;
          border-radius: 12px;
          font-size: 11px;
          background: var(--light);
          color: var(--gray);
        }

        /* My Dorm */
        .my-dorm-section {
          padding: 10px 0;
        }

        .dorm-detail-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
          margin-bottom: 20px;
        }

        .dorm-detail-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 15px;
        }

        .dorm-detail-header h3 {
          font-size: 20px;
          font-weight: 700;
          color: var(--secondary);
          margin: 0;
        }

        .dorm-gender {
          padding: 4px 16px;
          border-radius: 20px;
          font-size: 13px;
          font-weight: 600;
          background: var(--primary);
          color: white;
        }

        .dorm-detail-info {
          font-size: 14px;
          color: var(--gray);
        }

        .dorm-detail-info p {
          margin: 8px 0;
        }

        .dorm-detail-info i {
          width: 20px;
          color: var(--primary);
        }

        .patrons-section,
        .rules-section {
          margin-top: 20px;
        }

        .patrons-section h4,
        .rules-section h4 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin-bottom: 10px;
        }

        .patron-info {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 15px;
          background: var(--light);
          border-radius: 8px;
          margin-bottom: 8px;
        }

        .patron-info i {
          color: var(--primary);
        }

        .rules-section ul {
          list-style: none;
          padding: 0;
        }

        .rules-section ul li {
          padding: 12px 15px;
          background: var(--light);
          border-radius: 8px;
          margin-bottom: 8px;
        }

        .rules-section ul li strong {
          display: block;
          color: var(--secondary);
        }

        .rules-section ul li p {
          margin: 5px 0 0;
          font-size: 13px;
          color: var(--gray);
        }

        /* Table */
        .table-container {
          background: white;
          border-radius: 12px;
          box-shadow: var(--shadow);
          overflow: hidden;
        }

        .table-wrapper {
          overflow-x: auto;
        }

        table {
          width: 100%;
          border-collapse: collapse;
        }

        thead {
          background: var(--light);
        }

        th {
          padding: 12px 20px;
          text-align: left;
          font-size: 12px;
          font-weight: 600;
          color: var(--gray);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        td {
          padding: 12px 20px;
          border-bottom: 1px solid var(--border);
          font-size: 14px;
        }

        tr:hover {
          background: var(--light);
        }

        .status-badge {
          padding: 3px 12px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
        }

        .status-badge.resident {
          background: #d4edda;
          color: #155724;
        }

        .status-badge.temporary_leave {
          background: #fff3cd;
          color: #856404;
        }

        .status-badge.transferred {
          background: #d1ecf1;
          color: #0c5460;
        }

        .status-badge.graduated {
          background: #f8d7da;
          color: #721c24;
        }

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

        .empty-state h3 {
          color: var(--secondary);
          margin-bottom: 10px;
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

        .help-text {
          font-size: 12px;
          color: var(--gray);
          margin-top: 5px;
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

        /* Delete Modal */
        .delete-modal {
          max-width: 450px;
        }

        .delete-modal .warning-text {
          color: var(--danger);
          font-weight: 600;
        }

        /* Responsive */
        @media (max-width: 768px) {
          .stats-grid {
            grid-template-columns: repeat(2, 1fr);
          }

          .dorms-grid,
          .patrons-grid,
          .maintenance-grid,
          .inventory-grid {
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

          .dorm-detail-header {
            flex-direction: column;
            align-items: flex-start;
            gap: 10px;
          }
        }

        @media (max-width: 480px) {
          .stats-grid {
            grid-template-columns: 1fr;
          }

          .patron-header {
            flex-direction: column;
            align-items: center;
            text-align: center;
          }

          .student-info {
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

      <div className="boarding-container">
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
        {activeTab === 'dormitories' && renderDormitories()}
        {activeTab === 'assignments' && renderAssignments()}
        {activeTab === 'patrons' && renderPatrons()}
        {activeTab === 'maintenance' && renderMaintenance()}
        {activeTab === 'rules' && renderRules()}
        {activeTab === 'inventory' && renderInventory()}
        {activeTab === 'my-dorm' && isStudent && renderMyDorm()}
        {activeTab === 'student-dorm' && isParent && renderMyDorm()}
      </div>

      {/* Modal Overlay */}
      {showModal && (
        <div className="modal-overlay active" onClick={(e) => {
          if (e.target === e.currentTarget) setShowModal(false);
        }}>
          {renderModal()}
        </div>
      )}

      {/* Delete Modal */}
      {showDeleteModal && (
        <div className="modal-overlay active" onClick={(e) => {
          if (e.target === e.currentTarget) setShowDeleteModal(false);
        }}>
          <div className="modal delete-modal">
            <div className="modal-header">
              <h2>Confirm Delete</h2>
              <button className="modal-close" onClick={() => setShowDeleteModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <div style={{ padding: '20px 0' }}>
              <p style={{ marginBottom: '20px' }}>
                Are you sure you want to delete this <span className="warning-text">{deleteType}</span>?
                This action cannot be undone.
              </p>
              <div className="modal-footer">
                <button className="btn btn-outline" onClick={() => setShowDeleteModal(false)}>
                  Cancel
                </button>
                <button className="btn btn-danger" onClick={() => {
                  switch(deleteType) {
                    case 'dorm':
                      handleDeleteDorm();
                      break;
                    case 'assignment':
                      // handleDeleteAssignment();
                      setShowDeleteModal(false);
                      break;
                    case 'patron':
                      // handleDeletePatron();
                      setShowDeleteModal(false);
                      break;
                    case 'rule':
                      // handleDeleteRule();
                      setShowDeleteModal(false);
                      break;
                    case 'inventory':
                      // handleDeleteInventory();
                      setShowDeleteModal(false);
                      break;
                    default:
                      setShowDeleteModal(false);
                  }
                }}>
                  <i className="fas fa-trash"></i> Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
