// src/pages/Inventory.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { db } from '../firebase';
import { 
  collection, query, where, getDocs, doc, getDoc, 
  setDoc, updateDoc, deleteDoc, addDoc, serverTimestamp 
} from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';

import { showAppNotice } from '../utils/appNotice';
const CATEGORIES = [
  'Textbooks & Library',
  'Science Lab Equipment',
  'ICT & Computers',
  'Sports Equipment',
  'Furniture & Office',
  'Dormitory & Catering',
  'Maintenance & Tools',
  'General Supplies'
];

const CONDITIONS = ['New', 'Good', 'Fair', 'Needs Repair', 'Damaged'];
const STATUSES = ['In Stock', 'In Use', 'Assigned', 'Under Maintenance', 'Disposed'];

export default function Inventory() {
  const navigate = useNavigate();
  const { currentUser, userData, userRole } = useAuth();
  const { isOnline, saveToIndexedDB, getFromIndexedDB, addToSyncQueue } = useSync();

  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [items, setItems] = useState([]);
  const [logs, setLogs] = useState([]);
  
  // Search & Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');

  // Modals
  const [showItemModal, setShowItemModal] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [itemForm, setItemForm] = useState({
    name: '',
    category: 'Textbooks & Library',
    sku: '',
    quantity: 1,
    minQuantity: 5,
    unitPrice: 0,
    condition: 'New',
    status: 'In Stock',
    location: 'Main Store',
    assignedTo: '',
    notes: ''
  });

  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [adjustTarget, setAdjustTarget] = useState(null);
  const [adjustQty, setAdjustQty] = useState(1);
  const [adjustType, setAdjustType] = useState('add'); // add, remove, set
  const [adjustReason, setAdjustReason] = useState('');

  const schoolId = userData?.schoolId;

  useEffect(() => {
    if (schoolId) {
      loadInventoryData();
    }
  }, [schoolId]);

  const loadInventoryData = async () => {
    setLoading(true);
    try {
      if (!schoolId) {
        setLoading(false);
        return;
      }

      // Try loading from Firebase
      let loadedItems = [];
      let loadedLogs = [];

      try {
        const qItems = query(collection(db, 'school_inventory'), where('schoolId', '==', schoolId));
        const snapItems = await getDocs(qItems);
        snapItems.forEach(docSnap => {
          loadedItems.push({ id: docSnap.id, ...docSnap.data() });
        });

        const qLogs = query(collection(db, 'inventory_logs'), where('schoolId', '==', schoolId));
        const snapLogs = await getDocs(qLogs);
        snapLogs.forEach(docSnap => {
          loadedLogs.push({ id: docSnap.id, ...docSnap.data() });
        });

        await saveToIndexedDB(`inventory_${schoolId}`, loadedItems);
        await saveToIndexedDB(`inventory_logs_${schoolId}`, loadedLogs);
      } catch (err) {
        console.warn('Offline or error fetching inventory from Firestore, using IndexedDB cache', err);
        loadedItems = (await getFromIndexedDB(`inventory_${schoolId}`)) || [];
        loadedLogs = (await getFromIndexedDB(`inventory_logs_${schoolId}`)) || [];
      }

      setItems(loadedItems);
      setLogs(loadedLogs);
    } catch (error) {
      console.error('Error loading inventory data:', error);
      showNotification('Failed to load inventory', 'error');
    } finally {
      setLoading(false);
    }
  };

  const showNotification = (message, type = 'info') => {
        showAppNotice(message, type);
    };

  // Stats calculations
  const totalItemsCount = useMemo(() => items.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0), [items]);
  const totalAssetValue = useMemo(() => items.reduce((sum, i) => sum + ((Number(i.quantity) || 0) * (Number(i.unitPrice) || 0)), 0), [items]);
  const lowStockCount = useMemo(() => items.filter(i => (Number(i.quantity) || 0) <= (Number(i.minQuantity) || 5)).length, [items]);
  const damagedCount = useMemo(() => items.filter(i => i.condition === 'Damaged' || i.condition === 'Needs Repair').length, [items]);

  const filteredItems = useMemo(() => {
    return items.filter(i => {
      const matchesSearch = (i.name && i.name.toLowerCase().includes(searchTerm.toLowerCase())) ||
                            (i.sku && i.sku.toLowerCase().includes(searchTerm.toLowerCase())) ||
                            (i.location && i.location.toLowerCase().includes(searchTerm.toLowerCase()));
      const matchesCategory = categoryFilter === 'All' || i.category === categoryFilter;
      const matchesStatus = statusFilter === 'All' || i.status === statusFilter;
      return matchesSearch && matchesCategory && matchesStatus;
    });
  }, [items, searchTerm, categoryFilter, statusFilter]);

  const handleOpenAddModal = () => {
    setEditingItem(null);
    setItemForm({
      name: '',
      category: CATEGORIES[0],
      sku: `SKU-${Math.floor(1000 + Math.random() * 9000)}`,
      quantity: 1,
      minQuantity: 5,
      unitPrice: 0,
      condition: 'New',
      status: 'In Stock',
      location: 'Main Store',
      assignedTo: '',
      notes: ''
    });
    setShowItemModal(true);
  };

  const handleOpenEditModal = (item) => {
    setEditingItem(item);
    setItemForm({
      name: item.name || '',
      category: item.category || CATEGORIES[0],
      sku: item.sku || '',
      quantity: item.quantity || 0,
      minQuantity: item.minQuantity || 5,
      unitPrice: item.unitPrice || 0,
      condition: item.condition || 'New',
      status: item.status || 'In Stock',
      location: item.location || 'Main Store',
      assignedTo: item.assignedTo || '',
      notes: item.notes || ''
    });
    setShowItemModal(true);
  };

  const handleSaveItem = async (e) => {
    e.preventDefault();
    if (!itemForm.name.trim()) {
      showNotification('Please enter item name', 'error');
      return;
    }

    try {
      const itemData = {
        schoolId,
        name: itemForm.name.trim(),
        category: itemForm.category,
        sku: itemForm.sku.trim() || `SKU-${Date.now().toString().slice(-6)}`,
        quantity: Number(itemForm.quantity) || 0,
        minQuantity: Number(itemForm.minQuantity) || 5,
        unitPrice: Number(itemForm.unitPrice) || 0,
        condition: itemForm.condition,
        status: itemForm.status,
        location: itemForm.location.trim(),
        assignedTo: itemForm.assignedTo.trim(),
        notes: itemForm.notes.trim(),
        updatedAt: new Date().toISOString()
      };

      let updatedList = [...items];
      if (editingItem) {
        // Update
        if (isOnline) {
          const docRef = doc(db, 'school_inventory', editingItem.id);
          await updateDoc(docRef, itemData);
        }
        updatedList = items.map(i => i.id === editingItem.id ? { ...i, ...itemData } : i);
        showNotification('Inventory item updated successfully', 'success');
      } else {
        // Create
        let newId = `inv_${Date.now()}`;
        if (isOnline) {
          const docRef = await addDoc(collection(db, 'school_inventory'), itemData);
          newId = docRef.id;
        }
        updatedList = [{ id: newId, ...itemData }, ...items];
        showNotification('Inventory item added successfully', 'success');
      }

      setItems(updatedList);
      await saveToIndexedDB(`inventory_${schoolId}`, updatedList);
      setShowItemModal(false);
    } catch (error) {
      console.error('Error saving item:', error);
      showNotification('Failed to save inventory item', 'error');
    }
  };

  const handleDeleteItem = async (id) => {
    if (!window.confirm('Are you sure you want to delete this inventory item?')) return;
    try {
      if (isOnline) {
        await deleteDoc(doc(db, 'school_inventory', id));
      }
      const updated = items.filter(i => i.id !== id);
      setItems(updated);
      await saveToIndexedDB(`inventory_${schoolId}`, updated);
      showNotification('Inventory item deleted', 'success');
    } catch (error) {
      console.error('Error deleting item:', error);
      showNotification('Failed to delete item', 'error');
    }
  };

  const handleOpenAdjustModal = (item) => {
    setAdjustTarget(item);
    setAdjustQty(1);
    setAdjustType('add');
    setAdjustReason('');
    setShowAdjustModal(true);
  };

  const handleSaveAdjustment = async (e) => {
    e.preventDefault();
    if (!adjustTarget) return;

    let newQty = Number(adjustTarget.quantity) || 0;
    const change = Number(adjustQty) || 0;

    if (adjustType === 'add') newQty += change;
    else if (adjustType === 'remove') newQty = Math.max(0, newQty - change);
    else if (adjustType === 'set') newQty = change;

    try {
      const updatedItem = {
        ...adjustTarget,
        quantity: newQty,
        updatedAt: new Date().toISOString()
      };

      if (isOnline) {
        await updateDoc(doc(db, 'school_inventory', adjustTarget.id), {
          quantity: newQty,
          updatedAt: serverTimestamp()
        });
      }

      const updatedList = items.map(i => i.id === adjustTarget.id ? updatedItem : i);
      setItems(updatedList);
      await saveToIndexedDB(`inventory_${schoolId}`, updatedList);

      // Log adjustment
      const logEntry = {
        schoolId,
        itemId: adjustTarget.id,
        itemName: adjustTarget.name,
        action: `${adjustType.toUpperCase()} ${change} (New total: ${newQty})`,
        reason: adjustReason || 'Stock adjustment',
        user: userData?.fullName || currentUser?.email || 'Admin',
        timestamp: new Date().toISOString()
      };
      const updatedLogs = [logEntry, ...logs];
      setLogs(updatedLogs);
      await saveToIndexedDB(`inventory_logs_${schoolId}`, updatedLogs);

      showNotification('Stock adjusted successfully', 'success');
      setShowAdjustModal(false);
    } catch (error) {
      console.error('Error adjusting stock:', error);
      showNotification('Failed to adjust stock', 'error');
    }
  };

  if (loading) {
    return <LoadingSpinner fullScreen text="Loading School Inventory..." />;
  }

  return (
    <Layout title="School Inventory Management">
      <div style={{ maxWidth: 1200, margin: '0 auto', paddingBottom: 60 }}>
        {/* Header Actions & Navigation Tabs */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 16 }}>
          <div style={{ display: 'flex', gap: 8, background: '#f1f5f9', padding: 4, borderRadius: 10 }}>
            <button
              onClick={() => setActiveTab('overview')}
              style={{
                padding: '8px 16px',
                borderRadius: 8,
                border: 'none',
                background: activeTab === 'overview' ? '#1a237e' : 'transparent',
                color: activeTab === 'overview' ? '#fff' : '#475569',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 14
              }}
            >
              <i className="fas fa-chart-pie" style={{ marginRight: 6 }}></i> Overview
            </button>
            <button
              onClick={() => setActiveTab('items')}
              style={{
                padding: '8px 16px',
                borderRadius: 8,
                border: 'none',
                background: activeTab === 'items' ? '#1a237e' : 'transparent',
                color: activeTab === 'items' ? '#fff' : '#475569',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 14
              }}
            >
              <i className="fas fa-boxes" style={{ marginRight: 6 }}></i> Inventory Items ({items.length})
            </button>
            <button
              onClick={() => setActiveTab('logs')}
              style={{
                padding: '8px 16px',
                borderRadius: 8,
                border: 'none',
                background: activeTab === 'logs' ? '#1a237e' : 'transparent',
                color: activeTab === 'logs' ? '#fff' : '#475569',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 14
              }}
            >
              <i className="fas fa-history" style={{ marginRight: 6 }}></i> Activity Logs
            </button>
          </div>

          <button
            onClick={handleOpenAddModal}
            style={{
              background: '#1a237e',
              color: '#fff',
              border: 'none',
              padding: '10px 20px',
              borderRadius: 8,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: '0 4px 12px rgba(26, 35, 126, 0.2)'
            }}
          >
            <i className="fas fa-plus"></i> Add New Item
          </button>
        </div>

        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div>
            {/* KPI Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20, marginBottom: 30 }}>
              <div style={{ background: '#fff', padding: 24, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05)', borderLeft: '4px solid #1a237e' }}>
                <div style={{ color: '#64748b', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', marginBottom: 8 }}>Total Stock Units</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: '#0f172a' }}>{totalItemsCount.toLocaleString()}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>Across {items.length} unique catalog items</div>
              </div>
              <div style={{ background: '#fff', padding: 24, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05)', borderLeft: '4px solid #10b981' }}>
                <div style={{ color: '#64748b', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', marginBottom: 8 }}>Total Asset Value</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: '#0f172a' }}>KES {totalAssetValue.toLocaleString()}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>Estimated replacement value</div>
              </div>
              <div style={{ background: '#fff', padding: 24, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05)', borderLeft: '4px solid #f59e0b' }}>
                <div style={{ color: '#64748b', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', marginBottom: 8 }}>Low Stock Alerts</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: lowStockCount > 0 ? '#d97706' : '#0f172a' }}>{lowStockCount}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>Items at or below minimum threshold</div>
              </div>
              <div style={{ background: '#fff', padding: 24, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05)', borderLeft: '4px solid #ef4444' }}>
                <div style={{ color: '#64748b', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', marginBottom: 8 }}>Damaged / Repairs</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: damagedCount > 0 ? '#dc2626' : '#0f172a' }}>{damagedCount}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>Requires maintenance or disposal</div>
              </div>
            </div>

            {/* Category Breakdown & Low Stock Warning box */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))', gap: 24 }}>
              <div style={{ background: '#fff', padding: 24, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <i className="fas fa-tags" style={{ color: '#1a237e' }}></i> Category Breakdown
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {CATEGORIES.map(cat => {
                    const catItems = items.filter(i => i.category === cat);
                    const catCount = catItems.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
                    const catValue = catItems.reduce((sum, i) => sum + ((Number(i.quantity) || 0) * (Number(i.unitPrice) || 0)), 0);
                    if (catItems.length === 0) return null;
                    return (
                      <div key={cat} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: '#f8fafc', borderRadius: 8 }}>
                        <div>
                          <div style={{ fontWeight: 600, color: '#1e293b', fontSize: 14 }}>{cat}</div>
                          <div style={{ fontSize: 12, color: '#64748b' }}>{catItems.length} items cataloged</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontWeight: 700, color: '#1a237e', fontSize: 14 }}>{catCount} units</div>
                          <div style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>KES {catValue.toLocaleString()}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ background: '#fff', padding: 24, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <i className="fas fa-exclamation-triangle" style={{ color: '#f59e0b' }}></i> Low Stock Alerts
                </h3>
                {items.filter(i => (Number(i.quantity) || 0) <= (Number(i.minQuantity) || 5)).length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: '#64748b' }}>
                    <i className="fas fa-check-circle" style={{ fontSize: 40, color: '#10b981', marginBottom: 12 }}></i>
                    <p style={{ fontWeight: 600 }}>All inventory items are well-stocked!</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {items.filter(i => (Number(i.quantity) || 0) <= (Number(i.minQuantity) || 5)).map(item => (
                      <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8 }}>
                        <div>
                          <div style={{ fontWeight: 700, color: '#92400e', fontSize: 14 }}>{item.name}</div>
                          <div style={{ fontSize: 12, color: '#b45309' }}>SKU: {item.sku} | Location: {item.location}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <span style={{ background: '#f59e0b', color: '#fff', padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700 }}>
                            Qty: {item.quantity} (Min: {item.minQuantity})
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ITEMS TAB */}
        {activeTab === 'items' && (
          <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
            {/* Filter Bar */}
            <div style={{ padding: 20, borderBottom: '1px solid #e2e8f0', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 260, position: 'relative' }}>
                <i className="fas fa-search" style={{ position: 'absolute', left: 14, top: '50% - 7px', color: '#94a3b8' }}></i>
                <input
                  type="text"
                  placeholder="Search by name, SKU or location..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px 10px 38px',
                    border: '1px solid #cbd5e1',
                    borderRadius: 8,
                    fontSize: 14
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <select
                  value={categoryFilter}
                  onChange={e => setCategoryFilter(e.target.value)}
                  style={{ padding: '10px 14px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14, background: '#fff' }}
                >
                  <option value="All">All Categories</option>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>

                <select
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value)}
                  style={{ padding: '10px 14px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14, background: '#fff' }}
                >
                  <option value="All">All Statuses</option>
                  {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>

            {/* Items Table */}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 14 }}>
                <thead>
                  <tr style={{ background: '#f8fafc', color: '#475569', borderBottom: '2px solid #e2e8f0' }}>
                    <th style={{ padding: '14px 16px' }}>Item Details</th>
                    <th style={{ padding: '14px 16px' }}>Category</th>
                    <th style={{ padding: '14px 16px', textAlign: 'center' }}>Quantity</th>
                    <th style={{ padding: '14px 16px', textAlign: 'right' }}>Unit Price (KES)</th>
                    <th style={{ padding: '14px 16px', textAlign: 'center' }}>Condition</th>
                    <th style={{ padding: '14px 16px', textAlign: 'center' }}>Status</th>
                    <th style={{ padding: '14px 16px', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#64748b' }}>
                        No inventory items found matching your filters.
                      </td>
                    </tr>
                  ) : (
                    filteredItems.map(item => {
                      const isLow = (Number(item.quantity) || 0) <= (Number(item.minQuantity) || 5);
                      return (
                        <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '14px 16px' }}>
                            <div style={{ fontWeight: 700, color: '#0f172a' }}>{item.name}</div>
                            <div style={{ fontSize: 12, color: '#64748b' }}>SKU: {item.sku} | Loc: {item.location}</div>
                          </td>
                          <td style={{ padding: '14px 16px', color: '#334155' }}>{item.category}</td>
                          <td style={{ padding: '14px 16px', textAlign: 'center' }}>
                            <span style={{ 
                              fontWeight: 700, 
                              color: isLow ? '#dc2626' : '#0f172a',
                              background: isLow ? '#fee2e2' : '#f1f5f9',
                              padding: '4px 10px',
                              borderRadius: 12
                            }}>
                              {item.quantity}
                            </span>
                          </td>
                          <td style={{ padding: '14px 16px', textAlign: 'right', fontWeight: 600, color: '#059669' }}>
                            {(Number(item.unitPrice) || 0).toLocaleString()}
                          </td>
                          <td style={{ padding: '14px 16px', textAlign: 'center' }}>
                            <span style={{
                              fontSize: 12,
                              fontWeight: 600,
                              padding: '4px 8px',
                              borderRadius: 6,
                              background: item.condition === 'New' ? '#dcfce7' : item.condition === 'Good' ? '#e0f2fe' : '#fee2e2',
                              color: item.condition === 'New' ? '#166534' : item.condition === 'Good' ? '#0369a1' : '#991b1b'
                            }}>
                              {item.condition}
                            </span>
                          </td>
                          <td style={{ padding: '14px 16px', textAlign: 'center' }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: '#475569' }}>
                              {item.status}
                            </span>
                          </td>
                          <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                              <button
                                onClick={() => handleOpenAdjustModal(item)}
                                title="Adjust Stock"
                                style={{ background: '#e0e7ff', color: '#3730a3', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                              >
                                <i className="fas fa-sliders-h"></i> Adjust
                              </button>
                              <button
                                onClick={() => handleOpenEditModal(item)}
                                title="Edit Item"
                                style={{ background: '#f1f5f9', color: '#334155', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
                              >
                                <i className="fas fa-edit"></i>
                              </button>
                              <button
                                onClick={() => handleDeleteItem(item.id)}
                                title="Delete Item"
                                style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
                              >
                                <i className="fas fa-trash"></i>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* LOGS TAB */}
        {activeTab === 'logs' && (
          <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05)', padding: 24 }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', marginBottom: 16 }}>Inventory Activity & Stock Logs</h3>
            {logs.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#64748b' }}>
                <p>No inventory activity logs recorded yet.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {logs.map((log, idx) => (
                  <div key={idx} style={{ padding: 14, background: '#f8fafc', borderRadius: 8, borderLeft: '4px solid #1a237e', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 14 }}>{log.itemName} - <span style={{ color: '#1a237e' }}>{log.action}</span></div>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>Reason: {log.reason} | By: {log.user}</div>
                    </div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      {log.timestamp ? new Date(log.timestamp).toLocaleString() : 'Just now'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ADD / EDIT ITEM MODAL */}
      {showItemModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 650, padding: 30, boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)', maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', marginBottom: 20 }}>
              {editingItem ? 'Edit Inventory Item' : 'Add New Inventory Item'}
            </h2>
            <form onSubmit={handleSaveItem} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Item Name *</label>
                <input
                  type="text"
                  required
                  value={itemForm.name}
                  onChange={e => setItemForm({ ...itemForm, name: e.target.value })}
                  placeholder="e.g. Physics Textbooks Form 3"
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14 }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Category</label>
                <select
                  value={itemForm.category}
                  onChange={e => setItemForm({ ...itemForm, category: e.target.value })}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14, background: '#fff' }}
                >
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>SKU / Barcode Code</label>
                <input
                  type="text"
                  value={itemForm.sku}
                  onChange={e => setItemForm({ ...itemForm, sku: e.target.value })}
                  placeholder="e.g. TB-PHY-F3"
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14 }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Initial Quantity</label>
                <input
                  type="number"
                  min="0"
                  value={itemForm.quantity}
                  onChange={e => setItemForm({ ...itemForm, quantity: e.target.value })}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14 }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Minimum Stock Alert Level</label>
                <input
                  type="number"
                  min="0"
                  value={itemForm.minQuantity}
                  onChange={e => setItemForm({ ...itemForm, minQuantity: e.target.value })}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14 }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Unit Price (KES)</label>
                <input
                  type="number"
                  min="0"
                  value={itemForm.unitPrice}
                  onChange={e => setItemForm({ ...itemForm, unitPrice: e.target.value })}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14 }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Condition</label>
                <select
                  value={itemForm.condition}
                  onChange={e => setItemForm({ ...itemForm, condition: e.target.value })}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14, background: '#fff' }}
                >
                  {CONDITIONS.map(cond => <option key={cond} value={cond}>{cond}</option>)}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Status</label>
                <select
                  value={itemForm.status}
                  onChange={e => setItemForm({ ...itemForm, status: e.target.value })}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14, background: '#fff' }}
                >
                  {STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Storage Location</label>
                <input
                  type="text"
                  value={itemForm.location}
                  onChange={e => setItemForm({ ...itemForm, location: e.target.value })}
                  placeholder="e.g. Main Store Room B"
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14 }}
                />
              </div>

              <div style={{ gridColumn: 'span 2' }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Notes / Remarks</label>
                <textarea
                  rows="2"
                  value={itemForm.notes}
                  onChange={e => setItemForm({ ...itemForm, notes: e.target.value })}
                  placeholder="Optional details..."
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14 }}
                />
              </div>

              <div style={{ gridColumn: 'span 2', display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 12 }}>
                <button
                  type="button"
                  onClick={() => setShowItemModal(false)}
                  style={{ padding: '10px 20px', background: '#f1f5f9', color: '#334155', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{ padding: '10px 20px', background: '#1a237e', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}
                >
                  {editingItem ? 'Save Changes' : 'Save Item'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* STOCK ADJUSTMENT MODAL */}
      {showAdjustModal && adjustTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 450, padding: 30, boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', marginBottom: 12 }}>Adjust Stock Quantity</h2>
            <p style={{ fontSize: 14, color: '#64748b', marginBottom: 20 }}>
              Item: <strong>{adjustTarget.name}</strong> (Current Qty: {adjustTarget.quantity})
            </p>
            <form onSubmit={handleSaveAdjustment} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Action Type</label>
                <select
                  value={adjustType}
                  onChange={e => setAdjustType(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14, background: '#fff' }}
                >
                  <option value="add">Add Stock (Restock)</option>
                  <option value="remove">Remove Stock (Issue/Damage)</option>
                  <option value="set">Set Exact Quantity</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Quantity</label>
                <input
                  type="number"
                  min="0"
                  required
                  value={adjustQty}
                  onChange={e => setAdjustQty(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14 }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Reason / Remarks</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Received new shipment from supplier"
                  value={adjustReason}
                  onChange={e => setAdjustReason(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14 }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() => setShowAdjustModal(false)}
                  style={{ padding: '10px 16px', background: '#f1f5f9', color: '#334155', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{ padding: '10px 16px', background: '#1a237e', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}
                >
                  Confirm Adjustment
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </Layout>
  );
}
