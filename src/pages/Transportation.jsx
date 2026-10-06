// src/pages/Transportation.jsx
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
const BUS_STATUS = {
  active: 'Active',
  inactive: 'Inactive',
  maintenance: 'Under Maintenance',
  fueling: 'Fueling',
  on_route: 'On Route',
  parked: 'Parked'
};

const BUS_STATUS_COLORS = {
  active: '#27ae60',
  inactive: '#95a5a6',
  maintenance: '#e74c3c',
  fueling: '#f39c12',
  on_route: '#3498db',
  parked: '#2c3e50'
};

const FUEL_TYPES = ['Petrol', 'Diesel', 'Electric', 'Hybrid'];
const PAYMENT_METHODS = ['Cash', 'M-Pesa', 'Bank Transfer', 'Cheque'];
const PAYMENT_STATUS = ['paid', 'pending', 'overdue'];

const ROUTE_DAYS = {
  mon: 'Monday',
  tue: 'Tuesday', 
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday'
};

export default function Transportation() {
  const navigate = useNavigate();
  const { currentUser, userData, userRole } = useAuth();
  const { isOnline, pendingCount, saveToIndexedDB, getFromIndexedDB, addToSyncQueue } = useSync();

  // State
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedBus, setSelectedBus] = useState(null);
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [modalType, setModalType] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteItem, setDeleteItem] = useState(null);
  const [deleteType, setDeleteType] = useState('');
  const [selectedDriver, setSelectedDriver] = useState(null);
  const [selectedAssignment, setSelectedAssignment] = useState(null);
  
  // Data states
  const [buses, setBuses] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [transportPayments, setTransportPayments] = useState([]);
  const [maintenanceRecords, setMaintenanceRecords] = useState([]);
  const [fuelRecords, setFuelRecords] = useState([]);
  const [students, setStudents] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [notifications, setNotifications] = useState([]);
  
  // Filter states
  const [filterBus, setFilterBus] = useState('');
  const [filterRoute, setFilterRoute] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  
  // Form states
  const [busForm, setBusForm] = useState({
    registrationNumber: '',
    model: '',
    capacity: '',
    status: 'active',
    fuelType: 'Diesel',
    insuranceExpiry: '',
    serviceDue: '',
    purchaseDate: '',
    notes: ''
  });

  const [routeForm, setRouteForm] = useState({
    name: '',
    startPoint: '',
    endPoint: '',
    stops: '',
    estimatedTime: '',
    distance: '',
    days: [],
    fee: '',
    notes: ''
  });

  const [driverForm, setDriverForm] = useState({
    name: '',
    email: '',
    phone: '',
    licenseNumber: '',
    licenseExpiry: '',
    assignedBus: '',
    status: 'active',
    notes: ''
  });

  const [assignmentForm, setAssignmentForm] = useState({
    studentId: '',
    routeId: '',
    busId: '',
    pickupPoint: '',
    dropoffPoint: '',
    pickupTime: '',
    dropoffTime: '',
    status: 'active',
    notes: ''
  });

  const [paymentForm, setPaymentForm] = useState({
    studentId: '',
    routeId: '',
    amount: '',
    paymentMethod: 'Cash',
    paymentDate: new Date().toISOString().split('T')[0],
    status: 'paid',
    reference: '',
    notes: ''
  });

  const [maintenanceForm, setMaintenanceForm] = useState({
    busId: '',
    type: 'routine',
    description: '',
    date: new Date().toISOString().split('T')[0],
    cost: '',
    status: 'scheduled',
    notes: ''
  });

  const [fuelForm, setFuelForm] = useState({
    busId: '',
    amount: '',
    cost: '',
    date: new Date().toISOString().split('T')[0],
    odometerReading: '',
    fuelType: 'Diesel',
    notes: ''
  });

  // Stats
  const [stats, setStats] = useState({
    totalBuses: 0,
    activeBuses: 0,
    totalRoutes: 0,
    totalStudents: 0,
    totalDrivers: 0,
    monthlyRevenue: 0,
    monthlyFuelCost: 0,
    monthlyMaintenance: 0,
    pendingPayments: 0
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

  const loadData = async () => {
    setLoading(true);
    try {
      const schoolId = userData?.schoolId || 'default_school';
      
      // Load all data in parallel
      const [
        busesData,
        routesData,
        driversData,
        assignmentsData,
        paymentsData,
        maintenanceData,
        fuelData,
        studentsData,
        teachersData
      ] = await Promise.all([
        loadCollection('buses', schoolId),
        loadCollection('routes', schoolId),
        loadCollection('drivers', schoolId),
        loadCollection('assignments', schoolId),
        loadCollection('transport_payments', schoolId),
        loadCollection('maintenance', schoolId),
        loadCollection('fuel_records', schoolId),
        loadCollection('students', schoolId),
        loadCollection('teachers', schoolId)
      ]);

      setBuses(busesData);
      setRoutes(routesData);
      setDrivers(driversData);
      setAssignments(assignmentsData);
      setTransportPayments(paymentsData);
      setMaintenanceRecords(maintenanceData);
      setFuelRecords(fuelData);
      setStudents(studentsData);
      setTeachers(teachersData);

      calculateStats(busesData, routesData, paymentsData, fuelData, maintenanceData);
      setLoading(false);

      // Set up realtime listeners if online
      if (isOnline) {
        setupRealtimeListeners(schoolId);
      }

    } catch (error) {
      console.error('Error loading transportation data:', error);
      showNotification('Failed to load data', 'error');
      setLoading(false);
    }
  };

  const loadCollection = async (collectionName, schoolId) => {
    try {
      // Try cache first
      const cached = await getFromIndexedDB(`transport_${collectionName}`);
      if (cached && cached.length > 0) {
        return cached;
      }

      // If online, fetch from Firestore
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
        await saveToIndexedDB(`transport_${collectionName}`, data);
        return data;
      }

      return [];
    } catch (error) {
      console.error(`Error loading ${collectionName}:`, error);
      return [];
    }
  };

  const setupRealtimeListeners = (schoolId) => {
    const collections = ['buses', 'routes', 'drivers', 'assignments', 'transport_payments', 'maintenance', 'fuel_records'];
    
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
        
        // Update state based on collection
        switch(collectionName) {
          case 'buses':
            setBuses(data);
            break;
          case 'routes':
            setRoutes(data);
            break;
          case 'drivers':
            setDrivers(data);
            break;
          case 'assignments':
            setAssignments(data);
            break;
          case 'transport_payments':
            setTransportPayments(data);
            break;
          case 'maintenance':
            setMaintenanceRecords(data);
            break;
          case 'fuel_records':
            setFuelRecords(data);
            break;
        }
        
        await saveToIndexedDB(`transport_${collectionName}`, data);
      }, (error) => {
        console.error(`Listener error for ${collectionName}:`, error);
      });
      
      // Store unsubscribe function
      if (!unsubscribeRef.current) {
        unsubscribeRef.current = unsubscribe;
      }
    });
  };

  const calculateStats = (busesData, routesData, paymentsData, fuelData, maintenanceData) => {
    const activeBuses = busesData.filter(b => b.status === 'active' || b.status === 'on_route').length;
    
    // Calculate monthly revenue (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const monthlyRevenue = paymentsData
      .filter(p => p.status === 'paid' && new Date(p.paymentDate) >= thirtyDaysAgo)
      .reduce((sum, p) => sum + (p.amount || 0), 0);
    
    const monthlyFuelCost = fuelData
      .filter(f => new Date(f.date) >= thirtyDaysAgo)
      .reduce((sum, f) => sum + (f.cost || 0), 0);
    
    const monthlyMaintenance = maintenanceData
      .filter(m => m.status === 'completed' && new Date(m.date) >= thirtyDaysAgo)
      .reduce((sum, m) => sum + (m.cost || 0), 0);
    
    const pendingPayments = paymentsData.filter(p => p.status === 'pending' || p.status === 'overdue').length;

    setStats({
      totalBuses: busesData.length,
      activeBuses: activeBuses,
      totalRoutes: routesData.length,
      totalStudents: students.length,
      totalDrivers: drivers.length,
      monthlyRevenue: monthlyRevenue,
      monthlyFuelCost: monthlyFuelCost,
      monthlyMaintenance: monthlyMaintenance,
      pendingPayments: pendingPayments
    });
  };

  // Role-based access
  const isAdmin = userRole === 'admin' || userRole === 'super_admin' || userRole === 'user';
  const isDriver = userRole === 'driver';
  const isAccountant = userRole === 'accountant';
  const isTeacher = userRole === 'teacher';
  const isStudent = userRole === 'student';

  // Get tabs based on role
  const getAvailableTabs = () => {
    const tabs = [];
    
    if (isAdmin || isDriver) {
      tabs.push({ id: 'dashboard', label: 'Dashboard', icon: 'fa-chart-pie' });
    }
    
    if (isAdmin) {
      tabs.push({ id: 'buses', label: 'Buses', icon: 'fa-bus' });
      tabs.push({ id: 'routes', label: 'Routes', icon: 'fa-route' });
      tabs.push({ id: 'drivers', label: 'Drivers', icon: 'fa-user-tie' });
      tabs.push({ id: 'assignments', label: 'Assignments', icon: 'fa-user-check' });
    }
    
    if (isAdmin || isAccountant) {
      tabs.push({ id: 'reports', label: 'Reports', icon: 'fa-file-alt' });
      tabs.push({ id: 'payments', label: 'Payments', icon: 'fa-coins' });
    }
    
    if (isAdmin || isDriver) {
      tabs.push({ id: 'maintenance', label: 'Maintenance', icon: 'fa-tools' });
      tabs.push({ id: 'fuel', label: 'Fuel Tracking', icon: 'fa-gas-pump' });
    }
    
    if (isStudent) {
      tabs.push({ id: 'my-rides', label: 'My Rides', icon: 'fa-child' });
    }
    
    if (isTeacher) {
      tabs.push({ id: 'student-rides', label: 'Student Rides', icon: 'fa-users' });
    }
    
    return tabs;
  };

  const tabs = getAvailableTabs();

  // Notification helper
  const showNotification = (message, type = 'info') => {
        showAppNotice(message, type);
    };

  // Bus CRUD operations
  const handleAddBus = async () => {
    try {
      const data = {
        ...busForm,
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'buses'), data);
      } else {
        await addToSyncQueue('buses', 'add', data);
        const updatedBuses = [data, ...buses];
        setBuses(updatedBuses);
        await saveToIndexedDB('transport_buses', updatedBuses);
      }

      showNotification('Bus added successfully!', 'success');
      setShowModal(false);
      resetBusForm();
    } catch (error) {
      console.error('Error adding bus:', error);
      showNotification('Failed to add bus', 'error');
    }
  };

  const handleUpdateBus = async () => {
    try {
      const data = {
        ...busForm,
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await updateDoc(doc(db, 'buses', selectedBus.id), data);
      } else {
        await addToSyncQueue('buses', 'update', { id: selectedBus.id, ...data });
      }

      const updatedBuses = buses.map(b => 
        b.id === selectedBus.id ? { ...b, ...data } : b
      );
      setBuses(updatedBuses);
      await saveToIndexedDB('transport_buses', updatedBuses);

      showNotification('Bus updated successfully!', 'success');
      setShowModal(false);
      setSelectedBus(null);
      resetBusForm();
    } catch (error) {
      console.error('Error updating bus:', error);
      showNotification('Failed to update bus', 'error');
    }
  };

  const handleDeleteBus = async () => {
    try {
      if (isOnline) {
        await deleteDoc(doc(db, 'buses', deleteItem.id));
      } else {
        await addToSyncQueue('buses', 'delete', { id: deleteItem.id });
      }

      const updatedBuses = buses.filter(b => b.id !== deleteItem.id);
      setBuses(updatedBuses);
      await saveToIndexedDB('transport_buses', updatedBuses);

      showNotification('Bus deleted successfully!', 'success');
      setShowDeleteModal(false);
      setDeleteItem(null);
    } catch (error) {
      console.error('Error deleting bus:', error);
      showNotification('Failed to delete bus', 'error');
    }
  };

  // Route CRUD operations
  const handleAddRoute = async () => {
    try {
      const data = {
        ...routeForm,
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'routes'), data);
      } else {
        await addToSyncQueue('routes', 'add', data);
        const updatedRoutes = [data, ...routes];
        setRoutes(updatedRoutes);
        await saveToIndexedDB('transport_routes', updatedRoutes);
      }

      showNotification('Route added successfully!', 'success');
      setShowModal(false);
      resetRouteForm();
    } catch (error) {
      console.error('Error adding route:', error);
      showNotification('Failed to add route', 'error');
    }
  };

  const handleUpdateRoute = async () => {
    try {
      const data = {
        ...routeForm,
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await updateDoc(doc(db, 'routes', selectedRoute.id), data);
      } else {
        await addToSyncQueue('routes', 'update', { id: selectedRoute.id, ...data });
      }

      const updatedRoutes = routes.map(r => 
        r.id === selectedRoute.id ? { ...r, ...data } : r
      );
      setRoutes(updatedRoutes);
      await saveToIndexedDB('transport_routes', updatedRoutes);

      showNotification('Route updated successfully!', 'success');
      setShowModal(false);
      setSelectedRoute(null);
      resetRouteForm();
    } catch (error) {
      console.error('Error updating route:', error);
      showNotification('Failed to update route', 'error');
    }
  };

  // Driver CRUD operations
  const handleAddDriver = async () => {
    try {
      const data = {
        ...driverForm,
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'drivers'), data);
      } else {
        await addToSyncQueue('drivers', 'add', data);
        const updatedDrivers = [data, ...drivers];
        setDrivers(updatedDrivers);
        await saveToIndexedDB('transport_drivers', updatedDrivers);
      }

      showNotification('Driver added successfully!', 'success');
      setShowModal(false);
      resetDriverForm();
    } catch (error) {
      console.error('Error adding driver:', error);
      showNotification('Failed to add driver', 'error');
    }
  };

const handleUpdateDriver = async () => {
    try {
        const data = {
            ...driverForm,
            updatedAt: new Date().toISOString()
        };

        if (isOnline) {
            await updateDoc(doc(db, 'drivers', selectedDriver.id), data);
        } else {
            await addToSyncQueue('drivers', 'update', { id: selectedDriver.id, ...data });
        }

        const updatedDrivers = drivers.map(d => 
            d.id === selectedDriver.id ? { ...d, ...data } : d
        );
        setDrivers(updatedDrivers);
        await saveToIndexedDB('transport_drivers', updatedDrivers);

        showNotification('Driver updated successfully!', 'success');
        setShowModal(false);
        setSelectedDriver(null);
        resetDriverForm();
    } catch (error) {
        console.error('Error updating driver:', error);
        showNotification('Failed to update driver', 'error');
    }
};

const handleDeleteDriver = async () => {
    try {
        if (isOnline) {
            await deleteDoc(doc(db, 'drivers', deleteItem.id));
        } else {
            await addToSyncQueue('drivers', 'delete', { id: deleteItem.id });
        }

        const updatedDrivers = drivers.filter(d => d.id !== deleteItem.id);
        setDrivers(updatedDrivers);
        await saveToIndexedDB('transport_drivers', updatedDrivers);

        showNotification('Driver deleted successfully!', 'success');
        setShowDeleteModal(false);
        setDeleteItem(null);
    } catch (error) {
        console.error('Error deleting driver:', error);
        showNotification('Failed to delete driver', 'error');
    }
};

  // Render functions
  const renderDashboard = () => {
    // Driver sees different dashboard
    if (isDriver) {
      const driverInfo = drivers.find(d => d.email === currentUser?.email);
      const assignedBus = buses.find(b => b.id === driverInfo?.assignedBus);
      const assignedRoute = routes.find(r => r.id === driverInfo?.assignedRoute);
      
      return (
        <div className="driver-dashboard">
          <div className="driver-welcome">
            <h2>Welcome, {driverInfo?.name || 'Driver'}!</h2>
            {assignedBus && (
              <div className="driver-info-card">
                <h3>Your Assigned Bus</h3>
                <p><strong>Bus:</strong> {assignedBus.registrationNumber} - {assignedBus.model}</p>
                <p><strong>Status:</strong> {BUS_STATUS[assignedBus.status] || assignedBus.status}</p>
                {assignedRoute && (
                  <>
                    <p><strong>Route:</strong> {assignedRoute.name}</p>
                    <p><strong>Route:</strong> {assignedRoute.startPoint} → {assignedRoute.endPoint}</p>
                  </>
                )}
              </div>
            )}
          </div>
          
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-label">Today's Students</div>
              <div className="stat-value">{assignments.filter(a => a.status === 'active').length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Fuel Used (Month)</div>
              <div className="stat-value">
                {fuelRecords
                  .filter(f => f.busId === assignedBus?.id)
                  .reduce((sum, f) => sum + (f.amount || 0), 0)} L
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Maintenance Due</div>
              <div className="stat-value">
                {maintenanceRecords
                  .filter(m => m.busId === assignedBus?.id && m.status === 'scheduled')
                  .length}
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Admin/Full dashboard
    return (
      <>
        <div className="stats-grid">
          <div className="stat-card" onClick={() => setActiveTab('buses')} style={{ cursor: 'pointer' }}>
            <div className="stat-label">Total Buses</div>
            <div className="stat-value">{stats.totalBuses}</div>
            <div className="stat-sub">{stats.activeBuses} Active</div>
          </div>
          <div className="stat-card" onClick={() => setActiveTab('routes')} style={{ cursor: 'pointer' }}>
            <div className="stat-label">Routes</div>
            <div className="stat-value">{stats.totalRoutes}</div>
          </div>
          <div className="stat-card" onClick={() => setActiveTab('drivers')} style={{ cursor: 'pointer' }}>
            <div className="stat-label">Drivers</div>
            <div className="stat-value">{stats.totalDrivers}</div>
          </div>
          <div className="stat-card" onClick={() => setActiveTab('payments')} style={{ cursor: 'pointer' }}>
            <div className="stat-label">Monthly Revenue</div>
            <div className="stat-value">KES {stats.monthlyRevenue.toLocaleString()}</div>
            <div className="stat-sub">{stats.pendingPayments} Pending Payments</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Monthly Fuel Cost</div>
            <div className="stat-value" style={{ color: '#e67e22' }}>
              KES {stats.monthlyFuelCost.toLocaleString()}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Monthly Maintenance</div>
            <div className="stat-value" style={{ color: '#e74c3c' }}>
              KES {stats.monthlyMaintenance.toLocaleString()}
            </div>
          </div>
        </div>

        {/* Recent Activity */}
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
  };

  const renderBuses = () => (
    <div className="buses-section">
      <div className="section-header">
        <h2>Buses</h2>
        <button className="btn btn-primary" onClick={() => {
          setModalType('bus');
          resetBusForm();
          setShowModal(true);
        }}>
          <i className="fas fa-plus"></i> Add Bus
        </button>
      </div>

      <div className="filters-section">
        <input
          type="text"
          className="search-input"
          placeholder="Search buses..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <select
          className="filter-select"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">All Status</option>
          {Object.entries(BUS_STATUS).map(([key, value]) => (
            <option key={key} value={key}>{value}</option>
          ))}
        </select>
      </div>

      <div className="buses-grid">
        {buses
          .filter(b => {
            const matchSearch = b.registrationNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
                              b.model.toLowerCase().includes(searchTerm.toLowerCase());
            const matchStatus = !filterStatus || b.status === filterStatus;
            return matchSearch && matchStatus;
          })
          .map(bus => (
            <div key={bus.id} className="bus-card">
              <div className="bus-header">
                <div className="bus-info">
                  <h3>{bus.registrationNumber}</h3>
                  <p>{bus.model}</p>
                </div>
                <span className="bus-status" style={{
                  background: BUS_STATUS_COLORS[bus.status] + '20',
                  color: BUS_STATUS_COLORS[bus.status]
                }}>
                  {BUS_STATUS[bus.status] || bus.status}
                </span>
              </div>
              <div className="bus-details">
                <p><i className="fas fa-users"></i> Capacity: {bus.capacity} students</p>
                <p><i className="fas fa-gas-pump"></i> Fuel: {bus.fuelType}</p>
                <p><i className="fas fa-calendar-alt"></i> Insurance: {bus.insuranceExpiry || 'N/A'}</p>
                <p><i className="fas fa-wrench"></i> Service Due: {bus.serviceDue || 'N/A'}</p>
              </div>
              <div className="bus-actions">
                <button className="btn btn-primary btn-sm" onClick={() => {
                  setSelectedBus(bus);
                  setModalType('bus');
                  setBusForm(bus);
                  setShowModal(true);
                }}>
                  <i className="fas fa-edit"></i> Edit
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => {
                  setDeleteItem(bus);
                  setDeleteType('bus');
                  setShowDeleteModal(true);
                }}>
                  <i className="fas fa-trash"></i>
                </button>
              </div>
            </div>
          ))}
        {buses.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-bus"></i>
            <p>No buses registered yet</p>
          </div>
        )}
      </div>
    </div>
  );

  const renderRoutes = () => (
    <div className="routes-section">
      <div className="section-header">
        <h2>Routes</h2>
        <button className="btn btn-primary" onClick={() => {
          setModalType('route');
          resetRouteForm();
          setShowModal(true);
        }}>
          <i className="fas fa-plus"></i> Add Route
        </button>
      </div>

      <div className="routes-grid">
        {routes.map(route => (
          <div key={route.id} className="route-card">
            <div className="route-header">
              <h3>{route.name}</h3>
            </div>
            <div className="route-details">
              <p><i className="fas fa-map-marker-alt"></i> {route.startPoint} → {route.endPoint}</p>
              <p><i className="fas fa-route"></i> Distance: {route.distance} km</p>
              <p><i className="fas fa-clock"></i> Est. Time: {route.estimatedTime} min</p>
              <p><i className="fas fa-money-bill"></i> Fee: KES {route.fee || '0'}</p>
              <p><i className="fas fa-calendar-day"></i> Days: {route.days?.map(d => ROUTE_DAYS[d]).join(', ') || 'N/A'}</p>
              <p><i className="fas fa-stop-circle"></i> Stops: {route.stops || 'N/A'}</p>
            </div>
            <div className="route-actions">
              <button className="btn btn-primary btn-sm" onClick={() => {
                setSelectedRoute(route);
                setModalType('route');
                setRouteForm(route);
                setShowModal(true);
              }}>
                <i className="fas fa-edit"></i> Edit
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => {
                setDeleteItem(route);
                setDeleteType('route');
                setShowDeleteModal(true);
              }}>
                <i className="fas fa-trash"></i>
              </button>
            </div>
          </div>
        ))}
        {routes.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-route"></i>
            <p>No routes created yet</p>
          </div>
        )}
      </div>
    </div>
  );

  const renderDrivers = () => (
    <div className="drivers-section">
      <div className="section-header">
        <h2>Drivers</h2>
        <button className="btn btn-primary" onClick={() => {
          setModalType('driver');
          resetDriverForm();
          setShowModal(true);
        }}>
          <i className="fas fa-plus"></i> Add Driver
        </button>
      </div>

      <div className="drivers-grid">
        {drivers.map(driver => {
          const assignedBus = buses.find(b => b.id === driver.assignedBus);
          return (
            <div key={driver.id} className="driver-card">
              <div className="driver-header">
                <div className="driver-avatar">
                  {(driver.name || 'D')[0].toUpperCase()}
                </div>
                <div>
                  <h3>{driver.name}</h3>
                  <p>{driver.email}</p>
                </div>
                <span className={`driver-status ${driver.status}`}>
                  {driver.status}
                </span>
              </div>
              <div className="driver-details">
                <p><i className="fas fa-phone"></i> {driver.phone}</p>
                <p><i className="fas fa-id-card"></i> License: {driver.licenseNumber}</p>
                <p><i className="fas fa-calendar-alt"></i> License Expires: {driver.licenseExpiry}</p>
                {assignedBus && (
                  <p><i className="fas fa-bus"></i> Assigned: {assignedBus.registrationNumber}</p>
                )}
                {driver.notes && <p><i className="fas fa-sticky-note"></i> {driver.notes}</p>}
              </div>
              <div className="driver-actions">
                <button className="btn btn-primary btn-sm" onClick={() => {
                  setSelectedDriver(driver);
                  setModalType('driver');
                  setDriverForm(driver);
                  setShowModal(true);
                }}>
                  <i className="fas fa-edit"></i> Edit
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => {
                  setDeleteItem(driver);
                  setDeleteType('driver');
                  setShowDeleteModal(true);
                }}>
                  <i className="fas fa-trash"></i>
                </button>
              </div>
            </div>
          );
        })}
        {drivers.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-user-tie"></i>
            <p>No drivers registered yet</p>
          </div>
        )}
      </div>
    </div>
  );

  const renderPayments = () => (
    <div className="payments-section">
      <div className="section-header">
        <h2>Transport Payments</h2>
        <button className="btn btn-primary" onClick={() => {
          setModalType('payment');
          resetPaymentForm();
          setShowModal(true);
        }}>
          <i className="fas fa-plus"></i> Record Payment
        </button>
      </div>

      <div className="filters-section">
        <input
          type="text"
          className="search-input"
          placeholder="Search by student or reference..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <select
          className="filter-select"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">All Status</option>
          {PAYMENT_STATUS.map(status => (
            <option key={status} value={status}>{status.charAt(0).toUpperCase() + status.slice(1)}</option>
          ))}
        </select>
        <input
          type="date"
          className="filter-select"
          value={filterDate}
          onChange={(e) => setFilterDate(e.target.value)}
        />
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Student</th>
              <th>Route</th>
              <th>Amount</th>
              <th>Method</th>
              <th>Date</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {transportPayments
              .filter(p => {
                const student = students.find(s => s.id === p.studentId);
                const matchSearch = (student?.firstName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                                  (student?.lastName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                                  (p.reference || '').toLowerCase().includes(searchTerm.toLowerCase());
                const matchStatus = !filterStatus || p.status === filterStatus;
                const matchDate = !filterDate || p.paymentDate === filterDate;
                return matchSearch && matchStatus && matchDate;
              })
              .map(payment => {
                const student = students.find(s => s.id === payment.studentId);
                const route = routes.find(r => r.id === payment.routeId);
                return (
                  <tr key={payment.id}>
                    <td>{student ? `${student.firstName} ${student.lastName}` : 'Unknown'}</td>
                    <td>{route?.name || 'N/A'}</td>
                    <td><strong>KES {payment.amount.toLocaleString()}</strong></td>
                    <td>{payment.paymentMethod}</td>
                    <td>{new Date(payment.paymentDate).toLocaleDateString()}</td>
                    <td>
                      <span className={`status-badge ${payment.status}`}>
                        {payment.status.charAt(0).toUpperCase() + payment.status.slice(1)}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-primary btn-sm" onClick={() => {
                        // View/edit payment
                      }}>
                        <i className="fas fa-eye"></i>
                      </button>
                    </td>
                  </tr>
                );
              })}
            {transportPayments.length === 0 && (
              <tr>
                <td colSpan="7">
                  <div className="empty-state">
                    <i className="fas fa-coins"></i>
                    <p>No payments recorded yet</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderMaintenance = () => (
    <div className="maintenance-section">
      <div className="section-header">
        <h2>Maintenance Records</h2>
        <button className="btn btn-primary" onClick={() => {
          setModalType('maintenance');
          resetMaintenanceForm();
          setShowModal(true);
        }}>
          <i className="fas fa-plus"></i> Add Record
        </button>
      </div>

      <div className="maintenance-grid">
        {maintenanceRecords.map(record => {
          const bus = buses.find(b => b.id === record.busId);
          return (
            <div key={record.id} className="maintenance-card">
              <div className="maintenance-header">
                <h3>{bus?.registrationNumber || 'N/A'}</h3>
                <span className={`maintenance-status ${record.status}`}>
                  {record.status}
                </span>
              </div>
              <div className="maintenance-details">
                <p><strong>Type:</strong> {record.type}</p>
                <p><strong>Description:</strong> {record.description}</p>
                <p><strong>Date:</strong> {new Date(record.date).toLocaleDateString()}</p>
                <p><strong>Cost:</strong> KES {record.cost?.toLocaleString() || '0'}</p>
                {record.notes && <p><strong>Notes:</strong> {record.notes}</p>}
              </div>
            </div>
          );
        })}
        {maintenanceRecords.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-tools"></i>
            <p>No maintenance records</p>
          </div>
        )}
      </div>
    </div>
  );

  const renderFuelTracking = () => (
    <div className="fuel-section">
      <div className="section-header">
        <h2>Fuel Tracking</h2>
        <button className="btn btn-primary" onClick={() => {
          setModalType('fuel');
          resetFuelForm();
          setShowModal(true);
        }}>
          <i className="fas fa-plus"></i> Record Fuel
        </button>
      </div>

      <div className="fuel-grid">
        {fuelRecords.map(record => {
          const bus = buses.find(b => b.id === record.busId);
          return (
            <div key={record.id} className="fuel-card">
              <div className="fuel-header">
                <h3>{bus?.registrationNumber || 'N/A'}</h3>
                <span className="fuel-type">{record.fuelType}</span>
              </div>
              <div className="fuel-details">
                <p><strong>Amount:</strong> {record.amount} L</p>
                <p><strong>Cost:</strong> KES {record.cost?.toLocaleString() || '0'}</p>
                <p><strong>Date:</strong> {new Date(record.date).toLocaleDateString()}</p>
                <p><strong>Odometer:</strong> {record.odometerReading || 'N/A'} km</p>
                {record.notes && <p><strong>Notes:</strong> {record.notes}</p>}
              </div>
            </div>
          );
        })}
        {fuelRecords.length === 0 && (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <i className="fas fa-gas-pump"></i>
            <p>No fuel records</p>
          </div>
        )}
      </div>
    </div>
  );

  const renderMyRides = () => {
    // Student view - show their assigned rides
    const student = students.find(s => s.id === currentUser?.uid || s.email === currentUser?.email);
    const myAssignments = assignments.filter(a => a.studentId === student?.id);
    
    return (
      <div className="my-rides-section">
        <h2>My Rides</h2>
        {myAssignments.length === 0 ? (
          <div className="empty-state">
            <i className="fas fa-child"></i>
            <p>You are not assigned to any route yet.</p>
          </div>
        ) : (
          myAssignments.map(assignment => {
            const route = routes.find(r => r.id === assignment.routeId);
            const bus = buses.find(b => b.id === assignment.busId);
            const driver = drivers.find(d => d.assignedBus === bus?.id);
            
            return (
              <div key={assignment.id} className="ride-card">
                <div className="ride-header">
                  <h3>{route?.name || 'N/A'}</h3>
                  <span className="ride-status">{assignment.status}</span>
                </div>
                <div className="ride-details">
                  <p><i className="fas fa-bus"></i> Bus: {bus?.registrationNumber || 'N/A'}</p>
                  <p><i className="fas fa-user-tie"></i> Driver: {driver?.name || 'N/A'}</p>
                  <p><i className="fas fa-map-pin"></i> Pickup: {assignment.pickupPoint} at {assignment.pickupTime}</p>
                  <p><i className="fas fa-flag"></i> Dropoff: {assignment.dropoffPoint} at {assignment.dropoffTime}</p>
                  <p><i className="fas fa-calendar-day"></i> Days: {route?.days?.map(d => ROUTE_DAYS[d]).join(', ') || 'N/A'}</p>
                </div>
              </div>
            );
          })
        )}
      </div>
    );
  };

  
  const renderAssignments = () => (
    <div className="assignments-section">
      <div className="section-header">
        <h2>Student Route Assignments</h2>
        <button className="btn btn-primary" onClick={() => {
          setModalType('assignment');
          setSelectedAssignment(null);
          setAssignmentForm({
            studentId: '', routeId: '', busId: '', pickupPoint: '', pickupTime: '', dropoffPoint: '', dropoffTime: '', status: 'active'
          });
          setShowModal(true);
        }}>
          <i className="fas fa-plus"></i> New Assignment
        </button>
      </div>
      <div className="filters-section">
        <input type="text" className="search-input" placeholder="Search by student name..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
      </div>
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Student</th>
              <th>Route</th>
              <th>Bus</th>
              <th>Pickup</th>
              <th>Dropoff</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {assignments
              .filter(a => {
                const s = students.find(s => s.id === a.studentId);
                if (!s) return false;
                const name = `${s.firstName} ${s.lastName}`.toLowerCase();
                return name.includes(searchTerm.toLowerCase());
              })
              .map(assignment => {
              const student = students.find(s => s.id === assignment.studentId);
              const route = routes.find(r => r.id === assignment.routeId);
              const bus = buses.find(b => b.id === assignment.busId);
              return (
                <tr key={assignment.id}>
                  <td>{student?.firstName} {student?.lastName}</td>
                  <td>{route?.name || 'N/A'}</td>
                  <td>{bus?.registrationNumber || 'N/A'}</td>
                  <td>{assignment.pickupPoint} at {assignment.pickupTime}</td>
                  <td>{assignment.dropoffPoint} at {assignment.dropoffTime}</td>
                  <td>
                    <span className={`status-badge ${assignment.status}`}>
                      {assignment.status.charAt(0).toUpperCase() + assignment.status.slice(1)}
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
          </tbody>
        </table>
      </div>
    </div>
  );

  
  const renderReports = () => {
    // Filter stats
    const totalCollected = transportPayments.reduce((sum, p) => p.status === 'completed' || p.status === 'success' ? sum + Number(p.amount || 0) : sum, 0);
    const activeAssignments = assignments.filter(a => a.status === 'active');
    
    return (
    <div className="reports-section">
      <div className="section-header">
        <h2>Transport Reports & Analytics</h2>
        <button className="btn btn-outline" onClick={() => window.print()}>
          <i className="fas fa-print"></i> Print Report
        </button>
      </div>

      <div className="stats-grid" style={{ marginBottom: '20px' }}>
        <div className="stat-card">
          <div className="stat-icon"><i className="fas fa-coins"></i></div>
          <div className="stat-info">
            <h3>Total Revenue</h3>
            <p>KES {totalCollected.toLocaleString()}</p>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon"><i className="fas fa-users"></i></div>
          <div className="stat-info">
            <h3>Active Assignments</h3>
            <p>{activeAssignments.length}</p>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon"><i className="fas fa-bus"></i></div>
          <div className="stat-info">
            <h3>Active Routes</h3>
            <p>{routes.length}</p>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon"><i className="fas fa-gas-pump"></i></div>
          <div className="stat-info">
            <h3>Fuel Records</h3>
            <p>{fuelRecords.length}</p>
          </div>
        </div>
      </div>

      <div className="reports-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px' }}>
        <div className="report-card" style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: 'var(--shadow)' }}>
          <h3 style={{ borderBottom: '1px solid var(--border)', paddingBottom: '10px', marginBottom: '15px' }}>Route Popularity</h3>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {routes.map(r => {
              const count = assignments.filter(a => a.routeId === r.id && a.status === 'active').length;
              return (
                <li key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px dashed var(--border)' }}>
                  <span>{r.name}</span>
                  <strong>{count} students</strong>
                </li>
              );
            })}
          </ul>
        </div>
        
        <div className="report-card" style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: 'var(--shadow)' }}>
          <h3 style={{ borderBottom: '1px solid var(--border)', paddingBottom: '10px', marginBottom: '15px' }}>Recent Payments</h3>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {transportPayments.slice(0, 5).map(p => {
              const student = students.find(s => s.id === p.studentId);
              return (
                <li key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px dashed var(--border)' }}>
                  <span>{student?.firstName} {student?.lastName}</span>
                  <span style={{ color: p.status === 'completed' || p.status === 'success' ? 'var(--success)' : 'var(--warning)' }}>
                    KES {p.amount}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
};

  const renderStudentRides = () => {
    // Teacher view - see students' rides
    return (
      <div className="student-rides-section">
        <h2>Student Rides</h2>
        <div className="filters-section">
          <input
            type="text"
            className="search-input"
            placeholder="Search student..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        
        <div className="students-rides-list">
          {students
            .filter(s => {
              const name = `${s.firstName || ''} ${s.lastName || ''}`.toLowerCase();
              return name.includes(searchTerm.toLowerCase());
            })
            .map(student => {
              const studentAssignments = assignments.filter(a => a.studentId === student.id);
              return (
                <div key={student.id} className="student-ride-item">
                  <div className="student-info">
                    <strong>{student.firstName} {student.lastName}</strong>
                    <span className="student-class">{student.class}</span>
                  </div>
                  <div className="ride-info">
                    {studentAssignments.length === 0 ? (
                      <span className="no-ride">No assigned route</span>
                    ) : (
                      studentAssignments.map(assignment => {
                        const route = routes.find(r => r.id === assignment.routeId);
                        return (
                          <div key={assignment.id} className="assignment-info">
                            <span>{route?.name || 'N/A'}</span>
                            <span className="time">{assignment.pickupTime}</span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      </div>
    );
  };

  // Form reset functions
  const resetBusForm = () => {
    setBusForm({
      registrationNumber: '',
      model: '',
      capacity: '',
      status: 'active',
      fuelType: 'Diesel',
      insuranceExpiry: '',
      serviceDue: '',
      purchaseDate: '',
      notes: ''
    });
  };

  const resetRouteForm = () => {
    setRouteForm({
      name: '',
      startPoint: '',
      endPoint: '',
      stops: '',
      estimatedTime: '',
      distance: '',
      days: [],
      fee: '',
      notes: ''
    });
  };

  const resetDriverForm = () => {
    setDriverForm({
      name: '',
      email: '',
      phone: '',
      licenseNumber: '',
      licenseExpiry: '',
      assignedBus: '',
      status: 'active',
      notes: ''
    });
  };

  const resetPaymentForm = () => {
    setPaymentForm({
      studentId: '',
      routeId: '',
      amount: '',
      paymentMethod: 'Cash',
      paymentDate: new Date().toISOString().split('T')[0],
      status: 'paid',
      reference: '',
      notes: ''
    });
  };

  const resetMaintenanceForm = () => {
    setMaintenanceForm({
      busId: '',
      type: 'routine',
      description: '',
      date: new Date().toISOString().split('T')[0],
      cost: '',
      status: 'scheduled',
      notes: ''
    });
  };

  const resetFuelForm = () => {
    setFuelForm({
      busId: '',
      amount: '',
      cost: '',
      date: new Date().toISOString().split('T')[0],
      odometerReading: '',
      fuelType: 'Diesel',
      notes: ''
    });
  };

  // Modal render function
  const renderModal = () => {
    switch(modalType) {
      case 'bus':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>{selectedBus ? 'Edit Bus' : 'Add Bus'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              selectedBus ? handleUpdateBus() : handleAddBus();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Registration Number <span className="required">*</span></label>
                  <input
                    type="text"
                    value={busForm.registrationNumber}
                    onChange={(e) => setBusForm({ ...busForm, registrationNumber: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Model <span className="required">*</span></label>
                  <input
                    type="text"
                    value={busForm.model}
                    onChange={(e) => setBusForm({ ...busForm, model: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Capacity <span className="required">*</span></label>
                  <input
                    type="number"
                    value={busForm.capacity}
                    onChange={(e) => setBusForm({ ...busForm, capacity: e.target.value })}
                    required
                    min="1"
                  />
                </div>
                <div className="form-group">
                  <label>Status</label>
                  <select
                    value={busForm.status}
                    onChange={(e) => setBusForm({ ...busForm, status: e.target.value })}
                  >
                    {Object.entries(BUS_STATUS).map(([key, value]) => (
                      <option key={key} value={key}>{value}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Fuel Type</label>
                  <select
                    value={busForm.fuelType}
                    onChange={(e) => setBusForm({ ...busForm, fuelType: e.target.value })}
                  >
                    {FUEL_TYPES.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Insurance Expiry</label>
                  <input
                    type="date"
                    value={busForm.insuranceExpiry}
                    onChange={(e) => setBusForm({ ...busForm, insuranceExpiry: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Service Due</label>
                  <input
                    type="date"
                    value={busForm.serviceDue}
                    onChange={(e) => setBusForm({ ...busForm, serviceDue: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Purchase Date</label>
                  <input
                    type="date"
                    value={busForm.purchaseDate}
                    onChange={(e) => setBusForm({ ...busForm, purchaseDate: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={busForm.notes}
                  onChange={(e) => setBusForm({ ...busForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {selectedBus ? 'Update' : 'Add'} Bus
                </button>
              </div>
            </form>
          </div>
        );

      case 'route':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>{selectedRoute ? 'Edit Route' : 'Add Route'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              selectedRoute ? handleUpdateRoute() : handleAddRoute();
            }}>
              <div className="form-group">
                <label>Route Name <span className="required">*</span></label>
                <input
                  type="text"
                  value={routeForm.name}
                  onChange={(e) => setRouteForm({ ...routeForm, name: e.target.value })}
                  required
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Start Point <span className="required">*</span></label>
                  <input
                    type="text"
                    value={routeForm.startPoint}
                    onChange={(e) => setRouteForm({ ...routeForm, startPoint: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>End Point <span className="required">*</span></label>
                  <input
                    type="text"
                    value={routeForm.endPoint}
                    onChange={(e) => setRouteForm({ ...routeForm, endPoint: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Distance (km) <span className="required">*</span></label>
                  <input
                    type="number"
                    value={routeForm.distance}
                    onChange={(e) => setRouteForm({ ...routeForm, distance: e.target.value })}
                    required
                    min="0.1"
                    step="0.1"
                  />
                </div>
                <div className="form-group">
                  <label>Estimated Time (minutes)</label>
                  <input
                    type="number"
                    value={routeForm.estimatedTime}
                    onChange={(e) => setRouteForm({ ...routeForm, estimatedTime: e.target.value })}
                    min="1"
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Fee (KES) <span className="required">*</span></label>
                  <input
                    type="number"
                    value={routeForm.fee}
                    onChange={(e) => setRouteForm({ ...routeForm, fee: e.target.value })}
                    required
                    min="0"
                  />
                </div>
                <div className="form-group">
                  <label>Operating Days</label>
                  <select
                    multiple
                    value={routeForm.days}
                    onChange={(e) => {
                      const options = e.target.options;
                      const selected = [];
                      for (let i = 0; i < options.length; i++) {
                        if (options[i].selected) {
                          selected.push(options[i].value);
                        }
                      }
                      setRouteForm({ ...routeForm, days: selected });
                    }}
                    style={{ height: '100px' }}
                  >
                    {Object.entries(ROUTE_DAYS).map(([key, value]) => (
                      <option key={key} value={key}>{value}</option>
                    ))}
                  </select>
                  <div className="help-text">Hold Ctrl/Cmd to select multiple days</div>
                </div>
              </div>
              <div className="form-group">
                <label>Stops</label>
                <textarea
                  value={routeForm.stops}
                  onChange={(e) => setRouteForm({ ...routeForm, stops: e.target.value })}
                  rows="2"
                  placeholder="Enter stops separated by commas"
                />
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={routeForm.notes}
                  onChange={(e) => setRouteForm({ ...routeForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {selectedRoute ? 'Update' : 'Add'} Route
                </button>
              </div>
            </form>
          </div>
        );

      case 'driver':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>{selectedDriver ? 'Edit Driver' : 'Add Driver'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              selectedDriver ? handleUpdateDriver() : handleAddDriver();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Full Name <span className="required">*</span></label>
                  <input
                    type="text"
                    value={driverForm.name}
                    onChange={(e) => setDriverForm({ ...driverForm, name: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Email <span className="required">*</span></label>
                  <input
                    type="email"
                    value={driverForm.email}
                    onChange={(e) => setDriverForm({ ...driverForm, email: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Phone <span className="required">*</span></label>
                  <input
                    type="tel"
                    value={driverForm.phone}
                    onChange={(e) => setDriverForm({ ...driverForm, phone: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>License Number <span className="required">*</span></label>
                  <input
                    type="text"
                    value={driverForm.licenseNumber}
                    onChange={(e) => setDriverForm({ ...driverForm, licenseNumber: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>License Expiry <span className="required">*</span></label>
                  <input
                    type="date"
                    value={driverForm.licenseExpiry}
                    onChange={(e) => setDriverForm({ ...driverForm, licenseExpiry: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Assigned Bus</label>
                  <select
                    value={driverForm.assignedBus}
                    onChange={(e) => setDriverForm({ ...driverForm, assignedBus: e.target.value })}
                  >
                    <option value="">None</option>
                    {buses.map(bus => (
                      <option key={bus.id} value={bus.id}>
                        {bus.registrationNumber} - {bus.model}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Status</label>
                  <select
                    value={driverForm.status}
                    onChange={(e) => setDriverForm({ ...driverForm, status: e.target.value })}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="on_leave">On Leave</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={driverForm.notes}
                  onChange={(e) => setDriverForm({ ...driverForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {selectedDriver ? 'Update' : 'Add'} Driver
                </button>
              </div>
            </form>
          </div>
        );

      
      case 'assignment':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>{selectedAssignment ? 'Edit Assignment' : 'Assign Student to Route'}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}><i className="fas fa-times"></i></button>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); handleAddAssignment(); }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Student <span className="required">*</span></label>
                  <select
                    value={assignmentForm.studentId}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, studentId: e.target.value })}
                    required
                  >
                    <option value="">Select Student</option>
                    {students.map(s => (
                      <option key={s.id} value={s.id}>{s.firstName} {s.lastName} ({s.class})</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Route <span className="required">*</span></label>
                  <select
                    value={assignmentForm.routeId}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, routeId: e.target.value })}
                    required
                  >
                    <option value="">Select Route</option>
                    {routes.map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Bus <span className="required">*</span></label>
                  <select
                    value={assignmentForm.busId}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, busId: e.target.value })}
                    required
                  >
                    <option value="">Select Bus</option>
                    {buses.map(b => (
                      <option key={b.id} value={b.id}>{b.registrationNumber}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Status <span className="required">*</span></label>
                  <select
                    value={assignmentForm.status}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, status: e.target.value })}
                    required
                  >
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Pickup Point</label>
                  <input
                    type="text"
                    value={assignmentForm.pickupPoint}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, pickupPoint: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Pickup Time</label>
                  <input
                    type="time"
                    value={assignmentForm.pickupTime}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, pickupTime: e.target.value })}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Dropoff Point</label>
                  <input
                    type="text"
                    value={assignmentForm.dropoffPoint}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, dropoffPoint: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Dropoff Time</label>
                  <input
                    type="time"
                    value={assignmentForm.dropoffTime}
                    onChange={(e) => setAssignmentForm({ ...assignmentForm, dropoffTime: e.target.value })}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary"><i className="fas fa-save"></i> Save</button>
              </div>
            </form>
          </div>
        );

      case 'payment':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>Record Payment</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              handleAddPayment();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Student <span className="required">*</span></label>
                  <select
                    value={paymentForm.studentId}
                    onChange={(e) => setPaymentForm({ ...paymentForm, studentId: e.target.value })}
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
                  <label>Route <span className="required">*</span></label>
                  <select
                    value={paymentForm.routeId}
                    onChange={(e) => setPaymentForm({ ...paymentForm, routeId: e.target.value })}
                    required
                  >
                    <option value="">Select Route</option>
                    {routes.map(r => (
                      <option key={r.id} value={r.id}>
                        {r.name} - KES {r.fee}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Amount (KES) <span className="required">*</span></label>
                  <input
                    type="number"
                    value={paymentForm.amount}
                    onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                    required
                    min="0"
                  />
                </div>
                <div className="form-group">
                  <label>Payment Method</label>
                  <select
                    value={paymentForm.paymentMethod}
                    onChange={(e) => setPaymentForm({ ...paymentForm, paymentMethod: e.target.value })}
                  >
                    {PAYMENT_METHODS.map(method => (
                      <option key={method} value={method}>{method}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Payment Date</label>
                  <input
                    type="date"
                    value={paymentForm.paymentDate}
                    onChange={(e) => setPaymentForm({ ...paymentForm, paymentDate: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Status</label>
                  <select
                    value={paymentForm.status}
                    onChange={(e) => setPaymentForm({ ...paymentForm, status: e.target.value })}
                  >
                    {PAYMENT_STATUS.map(status => (
                      <option key={status} value={status}>
                        {status.charAt(0).toUpperCase() + status.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Reference</label>
                  <input
                    type="text"
                    value={paymentForm.reference}
                    onChange={(e) => setPaymentForm({ ...paymentForm, reference: e.target.value })}
                    placeholder="Payment reference number"
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={paymentForm.notes}
                  onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Record Payment
                </button>
              </div>
            </form>
          </div>
        );

      case 'maintenance':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>Add Maintenance Record</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              handleAddMaintenance();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Bus <span className="required">*</span></label>
                  <select
                    value={maintenanceForm.busId}
                    onChange={(e) => setMaintenanceForm({ ...maintenanceForm, busId: e.target.value })}
                    required
                  >
                    <option value="">Select Bus</option>
                    {buses.map(b => (
                      <option key={b.id} value={b.id}>
                        {b.registrationNumber} - {b.model}
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
                    <option value="routine">Routine</option>
                    <option value="repair">Repair</option>
                    <option value="inspection">Inspection</option>
                    <option value="emergency">Emergency</option>
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
                  <label>Date</label>
                  <input
                    type="date"
                    value={maintenanceForm.date}
                    onChange={(e) => setMaintenanceForm({ ...maintenanceForm, date: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Cost (KES)</label>
                  <input
                    type="number"
                    value={maintenanceForm.cost}
                    onChange={(e) => setMaintenanceForm({ ...maintenanceForm, cost: e.target.value })}
                    min="0"
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Status</label>
                  <select
                    value={maintenanceForm.status}
                    onChange={(e) => setMaintenanceForm({ ...maintenanceForm, status: e.target.value })}
                  >
                    <option value="scheduled">Scheduled</option>
                    <option value="in_progress">In Progress</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
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
                  Add Record
                </button>
              </div>
            </form>
          </div>
        );

      case 'fuel':
        return (
          <div className="modal">
            <div className="modal-header">
              <h2>Record Fuel</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              handleAddFuel();
            }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Bus <span className="required">*</span></label>
                  <select
                    value={fuelForm.busId}
                    onChange={(e) => setFuelForm({ ...fuelForm, busId: e.target.value })}
                    required
                  >
                    <option value="">Select Bus</option>
                    {buses.map(b => (
                      <option key={b.id} value={b.id}>
                        {b.registrationNumber} - {b.model}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Fuel Type</label>
                  <select
                    value={fuelForm.fuelType}
                    onChange={(e) => setFuelForm({ ...fuelForm, fuelType: e.target.value })}
                  >
                    {FUEL_TYPES.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Amount (Liters) <span className="required">*</span></label>
                  <input
                    type="number"
                    value={fuelForm.amount}
                    onChange={(e) => setFuelForm({ ...fuelForm, amount: e.target.value })}
                    required
                    min="0.1"
                    step="0.1"
                  />
                </div>
                <div className="form-group">
                  <label>Cost (KES) <span className="required">*</span></label>
                  <input
                    type="number"
                    value={fuelForm.cost}
                    onChange={(e) => setFuelForm({ ...fuelForm, cost: e.target.value })}
                    required
                    min="0"
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Date</label>
                  <input
                    type="date"
                    value={fuelForm.date}
                    onChange={(e) => setFuelForm({ ...fuelForm, date: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Odometer Reading (km)</label>
                  <input
                    type="number"
                    value={fuelForm.odometerReading}
                    onChange={(e) => setFuelForm({ ...fuelForm, odometerReading: e.target.value })}
                    min="0"
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={fuelForm.notes}
                  onChange={(e) => setFuelForm({ ...fuelForm, notes: e.target.value })}
                  rows="2"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Record Fuel
                </button>
              </div>
            </form>
          </div>
        );

      default:
        return null;
    }
  };

  // Handle add payment
  
  const handleAddAssignment = async () => {
    try {
      const data = {
        ...assignmentForm,
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        if (selectedAssignment) {
          await updateDoc(doc(db, 'assignments', selectedAssignment.id), data);
        } else {
          await addDoc(collection(db, 'assignments'), data);
        }
      } else {
        if (selectedAssignment) {
           await addToSyncQueue('assignments', 'update', { id: selectedAssignment.id, ...data });
           setAssignments(assignments.map(a => a.id === selectedAssignment.id ? { ...a, ...data } : a));
        } else {
           await addToSyncQueue('assignments', 'add', data);
           setAssignments([data, ...assignments]);
        }
      }
      showNotification('Assignment saved successfully!', 'success');
      setShowModal(false);
    } catch (err) {
      console.error(err);
      showNotification('Error saving assignment', 'error');
    }
  };

  const handleDeleteAssignment = async () => {
    try {
      if (isOnline) {
        await deleteDoc(doc(db, 'assignments', deleteItem.id));
      } else {
        await addToSyncQueue('assignments', 'delete', { id: deleteItem.id });
        setAssignments(assignments.filter(a => a.id !== deleteItem.id));
      }
      showNotification('Assignment deleted', 'success');
      setShowDeleteModal(false);
    } catch (err) {
      console.error(err);
      showNotification('Error deleting assignment', 'error');
    }
  };

  const handleAddPayment = async () => {
    try {
      const data = {
        ...paymentForm,
        amount: parseFloat(paymentForm.amount),
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'transport_payments'), data);
      } else {
        await addToSyncQueue('transport_payments', 'add', data);
        const updatedPayments = [data, ...transportPayments];
        setTransportPayments(updatedPayments);
        await saveToIndexedDB('transport_payments', updatedPayments);
      }

      showNotification('Payment recorded successfully!', 'success');
      setShowModal(false);
      resetPaymentForm();
    } catch (error) {
      console.error('Error recording payment:', error);
      showNotification('Failed to record payment', 'error');
    }
  };

  // Handle add maintenance
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
        await addDoc(collection(db, 'maintenance'), data);
      } else {
        await addToSyncQueue('maintenance', 'add', data);
        const updatedRecords = [data, ...maintenanceRecords];
        setMaintenanceRecords(updatedRecords);
        await saveToIndexedDB('transport_maintenance', updatedRecords);
      }

      showNotification('Maintenance record added successfully!', 'success');
      setShowModal(false);
      resetMaintenanceForm();
    } catch (error) {
      console.error('Error adding maintenance record:', error);
      showNotification('Failed to add maintenance record', 'error');
    }
  };

  // Handle add fuel
  const handleAddFuel = async () => {
    try {
      const data = {
        ...fuelForm,
        amount: parseFloat(fuelForm.amount),
        cost: parseFloat(fuelForm.cost),
        schoolId: userData?.schoolId || 'default_school',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await addDoc(collection(db, 'fuel_records'), data);
      } else {
        await addToSyncQueue('fuel_records', 'add', data);
        const updatedRecords = [data, ...fuelRecords];
        setFuelRecords(updatedRecords);
        await saveToIndexedDB('transport_fuel_records', updatedRecords);
      }

      showNotification('Fuel record added successfully!', 'success');
      setShowModal(false);
      resetFuelForm();
    } catch (error) {
      console.error('Error adding fuel record:', error);
      showNotification('Failed to add fuel record', 'error');
    }
  };

  if (loading) {
    return <LoadingSpinner fullScreen text="Loading transportation data..." />;
  }

  return (
    <Layout title="Transportation Management">
      <style>{`
        .transport-container {
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

        /* Buses Grid */
        .buses-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 20px;
        }

        .bus-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
          transition: all 0.3s;
        }

        .bus-card:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-lg);
        }

        .bus-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 10px;
        }

        .bus-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
        }

        .bus-header p {
          font-size: 13px;
          color: var(--gray);
        }

        .bus-status {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
        }

        .bus-details {
          font-size: 13px;
          color: var(--gray);
          margin-bottom: 15px;
        }

        .bus-details p {
          margin: 5px 0;
        }

        .bus-details i {
          width: 18px;
          color: var(--primary);
        }

        .bus-actions {
          display: flex;
          gap: 8px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
        }

        /* Routes Grid */
        .routes-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 20px;
        }

        .route-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
          transition: all 0.3s;
        }

        .route-card:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-lg);
        }

        .route-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
          margin-bottom: 10px;
        }

        .route-details {
          font-size: 13px;
          color: var(--gray);
          margin-bottom: 15px;
        }

        .route-details p {
          margin: 5px 0;
        }

        .route-details i {
          width: 18px;
          color: var(--primary);
        }

        .route-actions {
          display: flex;
          gap: 8px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
        }

        /* Drivers Grid */
        .drivers-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 20px;
        }

        .driver-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
          transition: all 0.3s;
        }

        .driver-card:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-lg);
        }

        .driver-header {
          display: flex;
          align-items: center;
          gap: 15px;
          margin-bottom: 10px;
        }

        .driver-avatar {
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

        .driver-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
        }

        .driver-header p {
          font-size: 12px;
          color: var(--gray);
        }

        .driver-status {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
        }

        .driver-status.active {
          background: #d4edda;
          color: #155724;
        }

        .driver-status.inactive {
          background: #f8d7da;
          color: #721c24;
        }

        .driver-status.on_leave {
          background: #fff3cd;
          color: #856404;
        }

        .driver-status.suspended {
          background: #f8d7da;
          color: #721c24;
        }

        .driver-details {
          font-size: 13px;
          color: var(--gray);
          margin-bottom: 15px;
        }

        .driver-details p {
          margin: 5px 0;
        }

        .driver-details i {
          width: 18px;
          color: var(--primary);
        }

        .driver-actions {
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
        }

        .maintenance-status {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
        }

        .maintenance-status.scheduled {
          background: #fff3cd;
          color: #856404;
        }

        .maintenance-status.in_progress {
          background: #d1ecf1;
          color: #0c5460;
        }

        .maintenance-status.completed {
          background: #d4edda;
          color: #155724;
        }

        .maintenance-status.cancelled {
          background: #f8d7da;
          color: #721c24;
        }

        .maintenance-details {
          font-size: 13px;
          color: var(--gray);
        }

        .maintenance-details p {
          margin: 5px 0;
        }

        /* Fuel Grid */
        .fuel-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 20px;
        }

        .fuel-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
        }

        .fuel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }

        .fuel-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
        }

        .fuel-type {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          background: #e8f5e9;
          color: #2e7d32;
        }

        .fuel-details {
          font-size: 13px;
          color: var(--gray);
        }

        .fuel-details p {
          margin: 5px 0;
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

        .status-badge.paid {
          background: #d4edda;
          color: #155724;
        }

        .status-badge.pending {
          background: #fff3cd;
          color: #856404;
        }

        .status-badge.overdue {
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

        /* Driver Dashboard */
        .driver-dashboard {
          padding: 10px 0;
        }

        .driver-welcome {
          background: #4f46e5;
          border-radius: 16px;
          padding: 30px;
          color: white;
          margin-bottom: 30px;
        }

        .driver-welcome h2 {
          font-size: 24px;
          margin-bottom: 15px;
        }

        .driver-info-card {
          background: rgba(255, 255, 255, 0.15);
          border-radius: 12px;
          padding: 20px;
          backdrop-filter: blur(10px);
        }

        .driver-info-card h3 {
          font-size: 16px;
          margin-bottom: 10px;
        }

        .driver-info-card p {
          margin: 5px 0;
          opacity: 0.9;
        }

        /* Student Rides */
        .my-rides-section,
        .student-rides-section {
          padding: 10px 0;
        }

        .ride-card {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: var(--shadow);
          margin-bottom: 15px;
          transition: all 0.3s;
        }

        .ride-card:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-lg);
        }

        .ride-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }

        .ride-header h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--secondary);
        }

        .ride-status {
          padding: 2px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
          background: #d4edda;
          color: #155724;
        }

        .ride-details {
          font-size: 13px;
          color: var(--gray);
        }

        .ride-details p {
          margin: 5px 0;
        }

        .ride-details i {
          width: 20px;
          color: var(--primary);
        }

        .students-rides-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .student-ride-item {
          background: white;
          border-radius: 12px;
          padding: 15px 20px;
          box-shadow: var(--shadow);
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px;
        }

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

        .ride-info {
          display: flex;
          gap: 15px;
          flex-wrap: wrap;
        }

        .assignment-info {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: var(--gray);
        }

        .assignment-info .time {
          padding: 2px 8px;
          border-radius: 8px;
          background: var(--light);
          font-weight: 500;
        }

        .no-ride {
          color: var(--gray);
          font-size: 13px;
          font-style: italic;
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

          .buses-grid,
          .routes-grid,
          .drivers-grid,
          .maintenance-grid,
          .fuel-grid {
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

          .student-ride-item {
            flex-direction: column;
            align-items: stretch;
          }

          .modal {
            padding: 20px;
          }
        }

        @media (max-width: 480px) {
          .stats-grid {
            grid-template-columns: 1fr;
          }

          .driver-header {
            flex-direction: column;
            align-items: center;
            text-align: center;
          }

          .ride-header {
            flex-direction: column;
            align-items: flex-start;
            gap: 8px;
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

      <div className="transport-container">
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
        {activeTab === 'buses' && isAdmin && renderBuses()}
        {activeTab === 'routes' && isAdmin && renderRoutes()}
        {activeTab === 'drivers' && isAdmin && renderDrivers()}
        {activeTab === 'payments' && (isAdmin || isAccountant) && renderPayments()}
        {activeTab === 'maintenance' && (isAdmin || isDriver) && renderMaintenance()}
        {activeTab === 'fuel' && (isAdmin || isDriver) && renderFuelTracking()}
        {activeTab === 'my-rides' && isStudent && renderMyRides()}
        {activeTab === 'student-rides' && isTeacher && renderStudentRides()}
        {activeTab === 'reports' && (isAdmin || isAccountant) && renderReports()}
        {activeTab === 'assignments' && isAdmin && renderAssignments()}
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
                    case 'bus':
                      handleDeleteBus();
                      break;
                    case 'route':
                      // handleDeleteRoute();
                      break;
                    case 'assignment':
                      handleDeleteAssignment();
                      break;
                    case 'driver':
                      // handleDeleteDriver();
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
